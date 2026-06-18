import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

import { RoleRegistry, hydrateExtensionRoles, listExtensionRoles } from "@zendev-lab/pi-roles";
import {
  PI_GRAFT_PATCHER_ALLOWED_TOOLS,
  PI_GRAFT_PATCHER_ROLE_REF,
  registerPiGraftExtension,
  registerPiGraftSandboxExtension,
  type PiGraftExtensionApi,
  type PiGraftToolContext,
  type PiGraftToolDefinition,
  type PiGraftToolResult,
} from "../packages/pi-graft/src/index.ts";

const execFileAsync = promisify(execFile);
const graftRepo = process.env.GRAFT_REPO ?? resolve(process.cwd(), "../graft");
const graftBin = process.env.GRAFT_BIN ?? join(graftRepo, "target/debug/graft");
const graftdBin = process.env.GRAFT_DAEMON_BIN ?? join(graftRepo, "target/debug/graftd");

async function binaryAvailable(path: string): Promise<boolean> {
  try {
    await execFileAsync(path, ["--help"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailsResult(result: PiGraftToolResult): Record<string, unknown> {
  const value = result.details?.result;
  assert.ok(isRecord(value), "expected tool details.result to be an object");
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") assert.fail(message);
  return value;
}

async function executeTool(
  tool: PiGraftToolDefinition | undefined,
  name: string,
  params: Record<string, unknown>,
  ctx: PiGraftToolContext,
): Promise<PiGraftToolResult> {
  assert.ok(tool, `expected ${name} to be registered`);
  return tool.execute(name, params, undefined, undefined, ctx);
}

function createFakePi() {
  const tools = new Map<string, PiGraftToolDefinition>();
  const entries: unknown[] = [];
  const handlers = new Map<string, ExtensionHandler[]>();
  const pi: PiGraftExtensionApi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as ExtensionHandler]);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  return { pi, tools, entries, handlers };
}

async function writeMockGraft(dir: string, scriptBody: string): Promise<string> {
  const path = join(dir, "graft-mock");
  await writeFile(path, `#!/bin/sh\n${scriptBody}\n`);
  await chmod(path, 0o755);
  return path;
}

let envMutationLock: Promise<void> = Promise.resolve();

async function withEnvMutationLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = envMutationLock;
  let release!: () => void;
  envMutationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function envTest(name: string, callback: (t: TestContext) => Promise<void>): void {
  void test(name, async (t) => {
    await withEnvMutationLock(() => callback(t));
  });
}

type SimpleGraftRouteCase = {
  name: string;
  tempPrefix: string;
  toolName: string;
  params?: (paths: { dir: string; project: string }) => Record<string, unknown>;
  ctx?: (paths: { dir: string; project: string }) => PiGraftToolContext;
  mockOutput: string;
  expectedText: RegExp;
  expectedArgv: (paths: { dir: string; project: string }) => string[];
  expectedEnvelope?: Record<string, unknown>;
};

async function assertSimpleGraftRoute(route: SimpleGraftRouteCase): Promise<void> {
  await withEnvMutationLock(async () => {
    const dir = await mkdtemp(join(tmpdir(), route.tempPrefix));
    const project = join(dir, "project");
    const argvFile = join(dir, "argv.txt");
    const previousGraftBin = process.env.GRAFT_BIN;
    const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
    await mkdir(project, { recursive: true });
    process.env.PI_GRAFT_MOCK_ARGV = argvFile;
    process.env.GRAFT_BIN = await writeMockGraft(
      dir,
      `printf '%s\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\n${route.mockOutput}`,
    );

    try {
      const { pi, tools } = createFakePi();
      registerPiGraftExtension(pi);
      const paths = { dir, project };
      const result = await executeTool(
        tools.get(route.toolName),
        route.toolName,
        route.params?.(paths) ?? {},
        route.ctx?.(paths) ?? { cwd: dir },
      );
      assert.match(result.content[0].text, route.expectedText, route.name);
      if (route.expectedEnvelope) {
        assert.deepEqual(result.details?.envelope, route.expectedEnvelope, route.name);
      }
      assert.deepEqual(
        (await readFile(argvFile, "utf8")).trim().split("\n"),
        route.expectedArgv(paths),
        route.name,
      );
    } finally {
      if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
      else process.env.GRAFT_BIN = previousGraftBin;
      if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
      else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
      await rm(dir, { force: true, recursive: true });
    }
  });
}

void test("pi-graft registers the final high-frequency direct tool set and extension patcher role", () => {
  const { pi, tools, handlers } = createFakePi();
  registerPiGraftExtension(pi);

  const patcher = listExtensionRoles().find((role) => role.ref === PI_GRAFT_PATCHER_ROLE_REF);
  assert.ok(patcher, "expected pi-graft to register role:extension-patcher");
  assert.equal(patcher.id, "patcher");
  assert.equal(patcher.source, "extension");
  assert.deepEqual(patcher.allowedTools, [...PI_GRAFT_PATCHER_ALLOWED_TOOLS]);
  const patcherAllowedTools: readonly string[] = patcher.allowedTools ?? [];
  for (const forbiddenTool of [
    "ask",
    "ask_user",
    "ask_flow",
    "task",
    "task_write",
    "goal",
    "assign",
    "role",
    "workflow",
    "graft_patch",
  ]) {
    assert.equal(patcherAllowedTools.includes(forbiddenTool), false);
  }
  const registry = new RoleRegistry([]);
  hydrateExtensionRoles(registry);
  assert.equal(registry.select("patcher", { source: "extension" }).ref, PI_GRAFT_PATCHER_ROLE_REF);

  assert.deepEqual([...handlers.keys()], ["session_start"]);
  assert.equal("registerCommand" in pi, false);
  assert.equal(tools.has("graft_patch"), false);
  assert.deepEqual(
    [...tools.keys()],
    [
      "graft_help",
      "graft_init",
      "graft_status",
      "graft_ps",
      "graft_doctor",
      "graft_scratch_open",
      "graft_read",
      "graft_write",
      "graft_edit",
      "graft_delete",
      "graft_scratch_diff",
      "graft_scratch_drop",
      "graft_scratch_pin",
      "graft_scratch_unpin",
      "graft_candidate_from_scratch",
      "graft_validate",
      "graft_admit",
      "graft_show",
      "graft_evidence",
      "graft_candidates",
      "graft_search",
      "graft_materialize",
      "graft_repo",
      "graft_cli_exec",
    ],
  );
});

envTest("graft_help defaults to the maintained agent workflow topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-help-"));
  const argvFile = join(dir, "argv.txt");
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
  process.env.PI_GRAFT_MOCK_ARGV = argvFile;
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\necho 'Recommended workflow for agents and pi-graft tools'`,
  );

  try {
    const { pi, tools } = createFakePi();
    registerPiGraftExtension(pi);
    const result = await executeTool(tools.get("graft_help"), "graft_help", {}, { cwd: dir });
    assert.match(result.content[0].text, /Recommended workflow for agents and pi-graft tools/);
    assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
      "--cwd",
      dir,
      "explain",
      "agent-workflow",
    ]);
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
    else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
    await rm(dir, { force: true, recursive: true });
  }
});

void test("graft_cli_exec validates argv before daemon work", async () => {
  const { pi, tools } = createFakePi();
  registerPiGraftExtension(pi);
  const cliExec = tools.get("graft_cli_exec");
  await assert.rejects(
    () => executeTool(cliExec, "graft_cli_exec", { argv: [] }, { cwd: "/tmp/pi-graft-no-daemon" }),
    /argv must be a non-empty string array/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: "status" },
        { cwd: "/tmp/pi-graft-no-daemon" },
      ),
    /argv must be a string array/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: ["status", 1] },
        { cwd: "/tmp/pi-graft-no-daemon" },
      ),
    /argv\[1] must be a string/,
  );
});

void test("simple pi-graft tools use graft --json CLI routes", async () => {
  const routes: SimpleGraftRouteCase[] = [
    {
      name: "graft_ps",
      tempPrefix: "pi-graft-ps-",
      toolName: "graft_ps",
      mockOutput: `printf '{"message":"ps direct"}\n'`,
      expectedText: /ps direct/,
      expectedArgv: ({ dir }) => ["--cwd", dir, "--json", "ps"],
    },
    {
      name: "graft_init",
      tempPrefix: "pi-graft-init-",
      toolName: "graft_init",
      params: ({ project }) => ({ cwd: project }),
      mockOutput: `printf '{"status":"ok","message":"initialized mock"}\n'`,
      expectedText: /initialized mock/,
      expectedEnvelope: { status: "ok", message: "initialized mock" },
      expectedArgv: ({ project }) => ["--cwd", project, "--json", "init"],
    },
    {
      name: "graft_doctor",
      tempPrefix: "pi-graft-doctor-",
      toolName: "graft_doctor",
      params: () => ({ rebuildRegistry: true }),
      mockOutput: `printf '{"message":"doctor ok"}\n'`,
      expectedText: /doctor ok/,
      expectedArgv: ({ dir }) => ["--cwd", dir, "--json", "doctor", "--rebuild-registry"],
    },
    {
      name: "graft_validate",
      tempPrefix: "pi-graft-validate-cli-",
      toolName: "graft_validate",
      params: () => ({ target: "candidate:abc" }),
      ctx: ({ project }) => ({ cwd: project }),
      mockOutput: `printf '{"message":"validation completed"}\n'`,
      expectedText: /validation completed/,
      expectedArgv: ({ project }) => ["--cwd", project, "--json", "validate", "candidate:abc"],
    },
    {
      name: "graft_status",
      tempPrefix: "pi-graft-status-cli-",
      toolName: "graft_status",
      ctx: ({ project }) => ({ cwd: project }),
      mockOutput: `printf '{"message":"status","result":{"status":"ok","daemon":"graftd"}}\n'`,
      expectedText: /graftd: ok/,
      expectedArgv: ({ project }) => ["--cwd", project, "--json", "scratch", "status"],
    },
    {
      name: "graft_repo list",
      tempPrefix: "pi-graft-repo-list-",
      toolName: "graft_repo",
      params: () => ({ action: "list" }),
      mockOutput: `printf '{"message":"spark present .graft/repos/spark local"}\n'`,
      expectedText: /spark/,
      expectedArgv: ({ dir }) => ["--cwd", dir, "--json", "repo", "list"],
    },
    {
      name: "graft_repo add",
      tempPrefix: "pi-graft-repo-add-",
      toolName: "graft_repo",
      params: () => ({
        action: "add",
        repoId: "spark",
        url: "/repos/spark",
        defaultBranch: "main",
      }),
      ctx: ({ project }) => ({ cwd: project }),
      mockOutput: `printf '{"message":"added repo spark"}\n'`,
      expectedText: /added repo spark/,
      expectedArgv: ({ project }) => [
        "--cwd",
        project,
        "--json",
        "repo",
        "add",
        "spark",
        "/repos/spark",
        "--default-branch",
        "main",
      ],
    },
  ];

  for (const route of routes) {
    await assertSimpleGraftRoute(route);
  }
});

void test("pi-graft tools require explicit cwd or restored session state", async () => {
  const { pi, tools } = createFakePi();
  registerPiGraftExtension(pi);

  const status = tools.get("graft_status");
  assert.ok(status, "expected graft_status tool to be registered");
  await assert.rejects(
    () => status.execute("graft_status", {}),
    /pi-graft tools require a cwd context or restored session state/,
  );
});

envTest("graft scratch lifecycle tools use graft --json CLI argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-scratch-cli-"));
  const project = join(dir, "project");
  const argvFile = join(dir, "argv.txt");
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
  await mkdir(project, { recursive: true });
  process.env.PI_GRAFT_MOCK_ARGV = argvFile;
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `printf '%s\\n' "$*" >> "$PI_GRAFT_MOCK_ARGV"
case "$*" in
  *"scratch open"*) printf '{"message":"opened","result":{"scratch":"scratch:open"}}\\n' ;;
  *"scratch pin"*) printf '{"message":"pinned","result":{"scratch":"scratch:open","lease":"lease:one","pinned":1}}\\n' ;;
  *"scratch diff"*) printf '{"message":"diff","result":{"from":"scratch:old","to":"scratch:open","changed_paths":["note.txt"]}}\\n' ;;
  *"scratch unpin"*) printf '{"message":"unpinned","result":{"scratch":"scratch:open","lease":"lease:one","pinned":0}}\\n' ;;
  *"scratch drop"*) printf '{"message":"dropped","result":{"scratch":"scratch:open","dropped":true}}\\n' ;;
  *) echo "unexpected argv: $*" >&2; exit 2 ;;
esac`,
  );

  try {
    const { pi, tools } = createFakePi();
    registerPiGraftExtension(pi);
    const ctx = { cwd: project };

    const opened = await executeTool(
      tools.get("graft_scratch_open"),
      "graft_scratch_open",
      { base: "graft:empty" },
      ctx,
    );
    assert.match(opened.content[0].text, /scratch:open/);

    const pinned = await executeTool(tools.get("graft_scratch_pin"), "graft_scratch_pin", {}, ctx);
    assert.match(pinned.content[0].text, /lease:one/);

    const diff = await executeTool(
      tools.get("graft_scratch_diff"),
      "graft_scratch_diff",
      { from: "scratch:old" },
      ctx,
    );
    assert.match(diff.content[0].text, /note\.txt/);

    const unpinned = await executeTool(
      tools.get("graft_scratch_unpin"),
      "graft_scratch_unpin",
      { lease: "lease:one" },
      ctx,
    );
    assert.match(unpinned.content[0].text, /scratch:open/);

    const dropped = await executeTool(
      tools.get("graft_scratch_drop"),
      "graft_scratch_drop",
      {},
      ctx,
    );
    assert.match(dropped.content[0].text, /Dropped graft scratch scratch:open/);

    assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
      `--cwd ${project} --json scratch open --base graft:empty`,
      `--cwd ${project} --json scratch pin scratch:open`,
      `--cwd ${project} --json scratch diff scratch:old scratch:open`,
      `--cwd ${project} --json scratch unpin lease:one`,
      `--cwd ${project} --json scratch drop scratch:open`,
    ]);
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
    else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
    await rm(dir, { force: true, recursive: true });
  }
});

envTest("graft write/edit pass large payloads over stdin flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-stdin-cli-"));
  const project = join(dir, "project");
  const argvFile = join(dir, "argv.txt");
  const stdinDir = join(dir, "stdin");
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
  const previousStdinDir = process.env.PI_GRAFT_MOCK_STDIN_DIR;
  await mkdir(project, { recursive: true });
  await mkdir(stdinDir, { recursive: true });
  process.env.PI_GRAFT_MOCK_ARGV = argvFile;
  process.env.PI_GRAFT_MOCK_STDIN_DIR = stdinDir;
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `printf '%s\\n' "$*" >> "$PI_GRAFT_MOCK_ARGV"
case "$*" in
  *"scratch write"*) cat > "$PI_GRAFT_MOCK_STDIN_DIR/write"; printf '{"message":"write","result":{"scratch":"scratch:write","path":"note.txt"}}\\n' ;;
  *"scratch edit"*) cat > "$PI_GRAFT_MOCK_STDIN_DIR/edit"; printf '{"message":"edit","result":{"scratch":"scratch:edit","path":"note.txt","updated_anchors":["1#AB:gamma"]}}\\n' ;;
  *) echo "unexpected argv: $*" >&2; exit 2 ;;
esac`,
  );

  try {
    const { pi, tools } = createFakePi();
    registerPiGraftExtension(pi);
    const ctx = { cwd: project };

    const written = await executeTool(
      tools.get("graft_write"),
      "graft_write",
      { base: "graft:empty", path: "note.txt", content: "alpha\nbeta\n" },
      ctx,
    );
    assert.match(written.content[0].text, /scratch:write/);

    const edited = await executeTool(
      tools.get("graft_edit"),
      "graft_edit",
      {
        from: "scratch:write",
        path: "note.txt",
        edits: [{ op: "replace", pos: "1#AB:alpha", lines: ["gamma"] }],
      },
      ctx,
    );
    assert.match(edited.content[0].text, /scratch:edit/);

    assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
      `--cwd ${project} --json scratch write --base graft:empty note.txt --content-stdin`,
      `--cwd ${project} --json scratch edit --from scratch:write note.txt --edits-stdin`,
    ]);
    assert.equal(await readFile(join(stdinDir, "write"), "utf8"), "alpha\nbeta\n");
    assert.equal(
      await readFile(join(stdinDir, "edit"), "utf8"),
      '[{"kind":"replace_line","line":1,"hash":"AB","old":"alpha","new":"gamma"}]',
    );
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
    else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
    if (previousStdinDir === undefined) delete process.env.PI_GRAFT_MOCK_STDIN_DIR;
    else process.env.PI_GRAFT_MOCK_STDIN_DIR = previousStdinDir;
    await rm(dir, { force: true, recursive: true });
  }
});

envTest(
  "graft sandbox read/write/edit overrides route file operations through graft scratch",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-graft-sandbox-tools-"));
    const project = join(dir, "project");
    const workspace = join(dir, "workspace");
    const argvFile = join(dir, "argv.txt");
    const stdinFile = join(dir, "stdin.txt");
    const previousGraftBin = process.env.GRAFT_BIN;
    const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
    const previousStdinFile = process.env.PI_GRAFT_MOCK_STDIN;
    await mkdir(project, { recursive: true });
    process.env.PI_GRAFT_MOCK_ARGV = argvFile;
    process.env.PI_GRAFT_MOCK_STDIN = stdinFile;
    process.env.GRAFT_BIN = await writeMockGraft(
      dir,
      `printf '%s\\n' "$*" >> "$PI_GRAFT_MOCK_ARGV"
case "$*" in
  *"scratch read"*) printf '%s\\n' '{"status":"ok","result":{"content":"alpha old\\nbeta\\n","scratch":"scratch:read"}}' ;;
  *"scratch write"*) cat > "$PI_GRAFT_MOCK_STDIN"; printf '%s\\n' '{"status":"ok","result":{"changed_paths":["src/example.ts"],"scratch":"scratch:write"}}' ;;
  *"init"*) printf '%s\\n' '{"status":"ok","workspace_id":"ws:sandbox-test"}' ;;
  *"repo add"*) printf '%s\\n' '{"status":"ok"}' ;;
  *"repo lock"*) printf '%s\\n' '{"status":"ok"}' ;;
  *) echo "unexpected argv: $*" >&2; exit 2 ;;
esac`,
    );

    try {
      const { pi, tools, entries, handlers } = createFakePi();
      registerPiGraftSandboxExtension(pi);
      for (const handler of handlers.get("session_start") ?? []) {
        await handler(
          { reason: "startup" },
          { cwd: project, sessionManager: { getEntries: () => entries } },
        );
      }

      const entered = await executeTool(
        tools.get("graft_sandbox_enter"),
        "graft_sandbox_enter",
        { repo: project, workspace, base: "main" },
        { cwd: project },
      );
      assert.match(entered.content[0].text, /GRAFT SANDBOX ACTIVE/);
      assert.match(entered.content[0].text, /writes: Graft scratch only/);

      const read = await executeTool(
        tools.get("read"),
        "read",
        { path: "src/example.ts", offset: 2, limit: 1 },
        { cwd: project },
      );
      assert.equal(read.content[0].text, "beta");
      assert.equal(read.details?.sandbox, true);
      assert.equal(read.details?.operation, "read");

      const write = await executeTool(
        tools.get("write"),
        "write",
        { path: "src/example.ts", content: "alpha old\nbeta\n" },
        { cwd: project },
      );
      assert.match(write.content[0].text, /Graft sandbox scratch scratch:write/);
      assert.equal(write.details?.sandbox, true);
      assert.equal(write.details?.operation, "write");

      const edit = await executeTool(
        tools.get("edit"),
        "edit",
        { path: "src/example.ts", edits: [{ oldText: "old", newText: "new" }] },
        { cwd: project },
      );
      assert.match(edit.content[0].text, /Edited src\/example\.ts in Graft sandbox scratch/);
      assert.equal(edit.details?.sandbox, true);
      assert.equal(edit.details?.operation, "edit");
      assert.match(String(edit.details?.diff), /--- a\/src\/example\.ts/);
      assert.match(String(edit.details?.patch), /\+\+\+ b\/src\/example\.ts/);
      assert.equal(edit.details?.firstChangedLine, 1);
      assert.equal(await readFile(stdinFile, "utf8"), "alpha new\nbeta\n");

      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        `--cwd ${workspace} --json init`,
        `--cwd ${workspace} --json repo add --default-branch main sandbox ${project}`,
        `--cwd ${workspace} --json repo lock sandbox`,
        `--cwd ${workspace} --json scratch read --base repo:sandbox@main src/example.ts --mode text`,
        `--cwd ${workspace} --json scratch write --from scratch:read src/example.ts --content-stdin`,
        `--cwd ${workspace} --json scratch read --from scratch:write src/example.ts --mode text`,
        `--cwd ${workspace} --json scratch write --from scratch:read src/example.ts --content-stdin`,
      ]);
    } finally {
      if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
      else process.env.GRAFT_BIN = previousGraftBin;
      if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
      else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
      if (previousStdinFile === undefined) delete process.env.PI_GRAFT_MOCK_STDIN;
      else process.env.PI_GRAFT_MOCK_STDIN = previousStdinFile;
      await rm(dir, { force: true, recursive: true });
    }
  },
);

envTest("graft sandbox grep/find/ls adapters use tracked changed scratch paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-sandbox-nav-"));
  const workspace = join(dir, "workspace");
  const previousGraftBin = process.env.GRAFT_BIN;
  await mkdir(workspace, { recursive: true });
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `case "$*" in
  *"src/example.ts"*) printf '%s\\n' '{"status":"ok","result":{"content":"alpha\\nneedle\\n","scratch":"scratch:nav"}}' ;;
  *"docs/readme.md"*) printf '%s\\n' '{"status":"ok","result":{"content":"docs\\n","scratch":"scratch:nav"}}' ;;
  *) echo "unexpected argv: $*" >&2; exit 2 ;;
esac`,
  );

  try {
    const restoredState = {
      active: true,
      repoRoot: "/repo",
      repoId: "sandbox",
      workspace,
      base: "repo:sandbox@main",
      lastScratch: "scratch:nav",
      changedPaths: ["src/example.ts", "docs/readme.md"],
      guardrails: { blockShellFileIo: true, allowValidationCommands: true },
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:01:00.000Z",
    };
    const { pi, tools, entries, handlers } = createFakePi();
    entries.push({
      type: "custom",
      customType: "pi-graft-sandbox-state",
      data: { state: restoredState },
    });
    registerPiGraftSandboxExtension(pi);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler(
        { reason: "startup" },
        { cwd: "/repo", sessionManager: { getEntries: () => entries } },
      );
    }

    const found = await executeTool(
      tools.get("find"),
      "find",
      { pattern: "*.ts" },
      { cwd: "/repo" },
    );
    assert.equal(found.content[0].text, "src/example.ts");

    const listed = await executeTool(tools.get("ls"), "ls", { path: "src" }, { cwd: "/repo" });
    assert.equal(listed.content[0].text, "example.ts");

    const rootListed = await executeTool(tools.get("ls"), "ls", { path: "" }, { cwd: "/repo" });
    assert.equal(rootListed.content[0].text, "docs/\nsrc/");

    const grepped = await executeTool(
      tools.get("grep"),
      "grep",
      { pattern: "needle", path: "src/example.ts" },
      { cwd: "/repo" },
    );
    assert.equal(grepped.content[0].text, "src/example.ts:2:needle");
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    await rm(dir, { force: true, recursive: true });
  }
});

envTest("graft sandbox edit rejects ambiguous and overlapping exact replacements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-sandbox-edit-errors-"));
  const project = join(dir, "project");
  const workspace = join(dir, "workspace");
  const argvFile = join(dir, "argv.txt");
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
  await mkdir(project, { recursive: true });
  process.env.PI_GRAFT_MOCK_ARGV = argvFile;
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `printf '%s\\n' "$*" >> "$PI_GRAFT_MOCK_ARGV"
case "$*" in
  *"scratch write"*) echo "sandbox edit error test must not write" >&2; exit 3 ;;
  *"scratch read"*) printf '%s\\n' '{"status":"ok","result":{"content":"abcdbc\\n","scratch":"scratch:read"}}' ;;
  *"init"*) printf '%s\\n' '{"status":"ok","workspace_id":"ws:sandbox-errors"}' ;;
  *"repo add"*) printf '%s\\n' '{"status":"ok"}' ;;
  *"repo lock"*) printf '%s\\n' '{"status":"ok"}' ;;
  *) echo "unexpected argv: $*" >&2; exit 2 ;;
esac`,
  );

  try {
    const { pi, tools, entries, handlers } = createFakePi();
    registerPiGraftSandboxExtension(pi);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler(
        { reason: "startup" },
        { cwd: project, sessionManager: { getEntries: () => entries } },
      );
    }
    await executeTool(
      tools.get("graft_sandbox_enter"),
      "graft_sandbox_enter",
      { repo: project, workspace, base: "main" },
      { cwd: project },
    );

    await assert.rejects(
      () =>
        executeTool(
          tools.get("edit"),
          "edit",
          { path: "src/example.ts", edits: [{ oldText: "zzz", newText: "x" }] },
          { cwd: project },
        ),
      /oldText was not found/,
    );
    await assert.rejects(
      () =>
        executeTool(
          tools.get("edit"),
          "edit",
          { path: "src/example.ts", edits: [{ oldText: "bc", newText: "x" }] },
          { cwd: project },
        ),
      /oldText must match exactly one location/,
    );
    await assert.rejects(
      () =>
        executeTool(
          tools.get("edit"),
          "edit",
          {
            path: "src/example.ts",
            edits: [
              { oldText: "abc", newText: "x" },
              { oldText: "bcd", newText: "y" },
            ],
          },
          { cwd: project },
        ),
      /overlaps/,
    );

    assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
      `--cwd ${workspace} --json init`,
      `--cwd ${workspace} --json repo add --default-branch main sandbox ${project}`,
      `--cwd ${workspace} --json repo lock sandbox`,
      `--cwd ${workspace} --json scratch read --base repo:sandbox@main src/example.ts --mode text`,
      `--cwd ${workspace} --json scratch read --base repo:sandbox@main src/example.ts --mode text`,
      `--cwd ${workspace} --json scratch read --base repo:sandbox@main src/example.ts --mode text`,
    ]);
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
    else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
    await rm(dir, { force: true, recursive: true });
  }
});

envTest("graft sandbox read reports unsupported non-text content clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-sandbox-binary-"));
  const project = join(dir, "project");
  const workspace = join(dir, "workspace");
  const previousGraftBin = process.env.GRAFT_BIN;
  await mkdir(project, { recursive: true });
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `case "$*" in
  *"scratch read"*) printf '%s\\n' '{"status":"ok","result":{"bytes":42,"scratch":"scratch:binary","binary":true}}' ;;
  *) printf '%s\\n' '{"status":"ok"}' ;;
esac`,
  );

  try {
    const { pi, tools, entries, handlers } = createFakePi();
    registerPiGraftSandboxExtension(pi);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler(
        { reason: "startup" },
        { cwd: project, sessionManager: { getEntries: () => entries } },
      );
    }
    await executeTool(
      tools.get("graft_sandbox_enter"),
      "graft_sandbox_enter",
      { repo: project, workspace, base: "main" },
      { cwd: project },
    );

    await assert.rejects(
      () => executeTool(tools.get("read"), "read", { path: "asset.bin" }, { cwd: project }),
      /UTF-8 text files only/,
    );
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    await rm(dir, { force: true, recursive: true });
  }
});

envTest("graft sandbox lifecycle checkpoints, materializes, and promotes explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-sandbox-lifecycle-"));
  const workspace = join(dir, "workspace");
  const argvFile = join(dir, "argv.txt");
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
  await mkdir(workspace, { recursive: true });
  process.env.PI_GRAFT_MOCK_ARGV = argvFile;
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `printf '%s\\n' "$*" >> "$PI_GRAFT_MOCK_ARGV"
case "$*" in
  *"candidate from-scratch"*) printf '%s\\n' '{"status":"ok","result":{"scratch":"scratch:write","candidate":"candidate:abc","changed_paths":["src/example.ts"]}}' ;;
  *"validate candidate:abc"*) printf '%s\\n' '{"status":"ok","message":"validated candidate:abc"}' ;;
  *"admit candidate:abc"*) printf '%s\\n' '{"status":"ok","message":"admitted candidate:abc","patch_id":"patch:def"}' ;;
  *"materialize patch:def --dry-run"*) printf '%s\\n' '{"status":"ok","message":"materialization dry-run for patch:def: resolved tree:123; would write state into /tmp/graft-dry"}' ;;
  *"materialize patch:def"*) printf '%s\\n' '{"status":"ok","message":"materialized patch:def: resolved tree:123 into /tmp/graft-real"}' ;;
  *"patch promote patch:def --to feature --yes"*) printf '%s\\n' '{"status":"ok","message":"promoted patch:def to refs/heads/feature at deadbeef","patch_id":"patch:def","promotions":[{"id":"promotion:ghi","patch_id":"patch:def","target":"feature","dry_run":false,"status":"updated refs/heads/feature to deadbeef","promoted_at":"now"}]}' ;;
  *"patch promote patch:def --to feature"*) printf '%s\\n' '{"status":"ok","message":"promotion dry-run for patch:def to branch feature; required evidence: tests_pass (source: explicit)","patch_id":"patch:def"}' ;;
  *) echo "unexpected argv: $*" >&2; exit 2 ;;
esac`,
  );

  try {
    const restoredState = {
      active: true,
      repoRoot: "/repo",
      repoId: "sandbox",
      workspace,
      base: "repo:sandbox@main",
      lastScratch: "scratch:write",
      changedPaths: ["src/example.ts"],
      guardrails: { blockShellFileIo: true, allowValidationCommands: true },
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:01:00.000Z",
    };
    const { pi, tools, entries, handlers } = createFakePi();
    entries.push({
      type: "custom",
      customType: "pi-graft-sandbox-state",
      data: { state: restoredState },
    });
    registerPiGraftSandboxExtension(pi);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler(
        { reason: "startup" },
        { cwd: "/repo", sessionManager: { getEntries: () => entries } },
      );
    }

    const checkpoint = await executeTool(
      tools.get("graft_sandbox_checkpoint"),
      "graft_sandbox_checkpoint",
      { expected: ["tests_pass"], admit: true },
      { cwd: "/repo" },
    );
    assert.match(checkpoint.content[0].text, /candidate candidate:abc/);
    assert.match(checkpoint.content[0].text, /Admitted patch: patch:def/);

    const dryMaterialize = await executeTool(
      tools.get("graft_sandbox_materialize"),
      "graft_sandbox_materialize",
      {},
      { cwd: "/repo" },
    );
    assert.match(dryMaterialize.content[0].text, /DRY RUN: no directory was created/);
    assert.equal(dryMaterialize.details?.plannedPath, "/tmp/graft-dry");

    const realMaterialize = await executeTool(
      tools.get("graft_sandbox_materialize"),
      "graft_sandbox_materialize",
      { dryRun: false },
      { cwd: "/repo" },
    );
    assert.match(
      realMaterialize.content[0].text,
      /Materialized inspection directory: \/tmp\/graft-real/,
    );
    assert.equal(
      (realMaterialize.details?.state as { lastMaterializedPath?: string } | undefined)
        ?.lastMaterializedPath,
      "/tmp/graft-real",
    );

    const dryPromote = await executeTool(
      tools.get("graft_sandbox_promote"),
      "graft_sandbox_promote",
      { to: "feature", required: ["tests_pass"] },
      { cwd: "/repo" },
    );
    assert.match(dryPromote.content[0].text, /DRY RUN: no Git refs were updated/);

    const appliedPromote = await executeTool(
      tools.get("graft_sandbox_promote"),
      "graft_sandbox_promote",
      { to: "feature", apply: true },
      { cwd: "/repo" },
    );
    assert.match(appliedPromote.content[0].text, /Promotion applied explicitly/);
    assert.deepEqual(
      (appliedPromote.details?.state as { lastPromotion?: unknown } | undefined)?.lastPromotion,
      { branch: "feature", commit: "deadbeef", promotion: "promotion:ghi" },
    );

    assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
      `--cwd ${workspace} --json candidate from-scratch scratch:write --expect tests_pass --producer @zendev-lab/pi-graft-sandbox`,
      `--cwd ${workspace} --json validate candidate:abc --expect tests_pass`,
      `--cwd ${workspace} --json admit candidate:abc --require tests_pass`,
      `--cwd ${workspace} --json materialize patch:def --dry-run`,
      `--cwd ${workspace} --json materialize patch:def`,
      `--cwd ${workspace} --json patch promote patch:def --to feature --require tests_pass`,
      `--cwd ${workspace} --json patch promote patch:def --to feature --yes`,
    ]);
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
    else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
    await rm(dir, { force: true, recursive: true });
  }
});

envTest("graft_candidate_from_scratch maps expected to CLI --expect flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-graft-candidate-cli-"));
  const project = join(dir, "project");
  const argvFile = join(dir, "argv.txt");
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousArgvFile = process.env.PI_GRAFT_MOCK_ARGV;
  await mkdir(project, { recursive: true });
  process.env.PI_GRAFT_MOCK_ARGV = argvFile;
  process.env.GRAFT_BIN = await writeMockGraft(
    dir,
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\nprintf '{"message":"candidate","result":{"scratch":"scratch:abc","candidate":"candidate:def","changed_paths":["note.txt"]}}\\n'`,
  );

  try {
    const { pi, tools } = createFakePi();
    registerPiGraftExtension(pi);
    const result = await executeTool(
      tools.get("graft_candidate_from_scratch"),
      "graft_candidate_from_scratch",
      { scratch: "scratch:abc", expected: ["tests_pass"] },
      { cwd: project },
    );
    assert.match(result.content[0].text, /candidate:def/);
    assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
      "--cwd",
      project,
      "--json",
      "candidate",
      "from-scratch",
      "scratch:abc",
      "--expect",
      "tests_pass",
      "--producer",
      "@zendev-lab/pi-graft",
    ]);
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    if (previousArgvFile === undefined) delete process.env.PI_GRAFT_MOCK_ARGV;
    else process.env.PI_GRAFT_MOCK_ARGV = previousArgvFile;
    await rm(dir, { force: true, recursive: true });
  }
});

envTest("pi-graft controls real graftd scratch lifecycle through canonical protocol", async (t) => {
  if (process.env.PI_GRAFT_E2E !== "1") {
    t.skip("set PI_GRAFT_E2E=1 to run the real graftd scratch lifecycle test");
    return;
  }
  if (!(await binaryAvailable(graftBin)) || !(await binaryAvailable(graftdBin))) {
    t.skip(`graft binaries not available at ${graftBin} and ${graftdBin}`);
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "pi-graft-e2e-"));
  const project = join(dir, "project");
  const graftHome = join(dir, "graft-home");
  const socket = join(graftHome, "run", "daemon.sock");
  const previousDaemonBin = process.env.GRAFT_DAEMON_BIN;
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousGraftHome = process.env.GRAFT_HOME;
  process.env.GRAFT_DAEMON_BIN = graftdBin;
  process.env.GRAFT_BIN = graftBin;
  process.env.GRAFT_HOME = graftHome;
  await mkdir(project, { recursive: true });

  try {
    const { pi, tools, entries, handlers } = createFakePi();
    registerPiGraftExtension(pi);
    const toolCtx: PiGraftToolContext = {
      cwd: project,
      sessionManager: { getBranch: () => entries },
    };
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, toolCtx);
    }
    const help = await executeTool(tools.get("graft_help"), "graft_help", {}, toolCtx);
    assert.match(help.content[0].text, /Recommended workflow for agents and pi-graft tools/);

    const init = await executeTool(tools.get("graft_init"), "graft_init", {}, toolCtx);
    assert.match(init.content[0].text, /initialized|already initialized/);

    const seedNote = await executeTool(
      tools.get("graft_write"),
      "graft_write",
      { base: "graft:empty", path: "note.txt", content: "alpha\nbeta\n" },
      toolCtx,
    );
    const scratchNote = requiredString(
      detailsResult(seedNote).scratch,
      "expected seed note write to return a scratch id",
    );
    assert.match(scratchNote, /^scratch:[0-9a-f]+$/);

    const seedRemove = await executeTool(
      tools.get("graft_write"),
      "graft_write",
      { from: scratchNote, path: "remove.txt", content: "remove me\n" },
      toolCtx,
    );
    const scratchSeed = requiredString(
      detailsResult(seedRemove).scratch,
      "expected seed remove write to return a scratch id",
    );

    const seedCandidateResult = await executeTool(
      tools.get("graft_candidate_from_scratch"),
      "graft_candidate_from_scratch",
      { scratch: scratchSeed, message: "pi-graft-seed" },
      toolCtx,
    );
    const seedCandidate = requiredString(
      detailsResult(seedCandidateResult).candidate,
      "expected seed candidate_from_scratch to return a candidate id",
    );
    assert.match(seedCandidate, /^candidate:[0-9a-f]+$/);

    const write = await executeTool(
      tools.get("graft_write"),
      "graft_write",
      { base: seedCandidate, path: "added.txt", content: "added\n" },
      toolCtx,
    );
    const scratchWrite = requiredString(
      detailsResult(write).scratch,
      "expected graft_write details.result.scratch to be a string",
    );
    assert.match(scratchWrite, /^scratch:[0-9a-f]+$/);

    const read = await executeTool(
      tools.get("graft_read"),
      "graft_read",
      { from: scratchWrite, path: "note.txt" },
      toolCtx,
    );
    const readText = read.content[0].text;
    const anchor = /^2#[^:]+:beta/m.exec(readText)?.[0];
    assert.ok(anchor, `expected hashline anchor for line 2 in ${readText}`);
    assert.match(requiredString(detailsResult(read).scratch, "expected read scratch"), /^scratch:/);

    const edit = await executeTool(
      tools.get("graft_edit"),
      "graft_edit",
      {
        from: scratchWrite,
        path: "note.txt",
        edits: [{ op: "replace", pos: anchor, lines: ["gamma"] }],
      },
      toolCtx,
    );
    assert.match(edit.content[0].text, /Updated anchors/);
    const scratchEdit = requiredString(
      detailsResult(edit).scratch,
      "expected graft_edit details.result.scratch to be a string",
    );

    const deleteResult = await executeTool(
      tools.get("graft_delete"),
      "graft_delete",
      { from: scratchEdit, path: "remove.txt" },
      toolCtx,
    );
    const scratchDelete = requiredString(
      detailsResult(deleteResult).scratch,
      "expected graft_delete details.result.scratch to be a string",
    );
    assert.match(deleteResult.content[0].text, /remove\.txt/);

    const candidateResult = await executeTool(
      tools.get("graft_candidate_from_scratch"),
      "graft_candidate_from_scratch",
      { scratch: scratchDelete, message: "pi-graft-candidate" },
      toolCtx,
    );
    const candidate = requiredString(
      detailsResult(candidateResult).candidate,
      "expected graft_candidate_from_scratch details.result.candidate to be a string",
    );
    assert.match(candidate, /^candidate:[0-9a-f]+$/);

    const changedPaths = detailsResult(candidateResult).changed_paths;
    assert.ok(Array.isArray(changedPaths), "expected candidate changed_paths");
    for (const path of ["added.txt", "note.txt", "remove.txt"]) {
      assert.ok(changedPaths.includes(path), `expected changed path ${path}`);
    }

    const validate = await executeTool(
      tools.get("graft_validate"),
      "graft_validate",
      { target: candidate },
      toolCtx,
    );
    assert.match(validate.content[0].text, /validation completed/);

    const admit = await executeTool(
      tools.get("graft_admit"),
      "graft_admit",
      { candidate },
      toolCtx,
    );
    assert.match(admit.content[0].text, /admitted|patch/i);
    const admitEnvelope = admit.details?.envelope;
    assert.ok(isRecord(admitEnvelope), "expected admit envelope");
    const patch = requiredString(admitEnvelope.patch_id, "expected admitted patch id");

    const show = await executeTool(
      tools.get("graft_show"),
      "graft_show",
      { target: patch, evidence: true, change: true },
      toolCtx,
    );
    assert.match(show.content[0].text, /patch/i);

    const evidence = await executeTool(
      tools.get("graft_evidence"),
      "graft_evidence",
      { subject: patch },
      toolCtx,
    );
    assert.ok(isRecord(evidence.details?.envelope), "expected evidence envelope");
    assert.match(evidence.content[0].text, /evidence|ValidPatch|property:/i);

    const materialize = await executeTool(
      tools.get("graft_materialize"),
      "graft_materialize",
      { patch, dryRun: true },
      toolCtx,
    );
    assert.match(materialize.content[0].text, /materialization dry-run/);

    const exported = await executeTool(
      tools.get("graft_cli_exec"),
      "graft_cli_exec",
      { argv: ["registry", "export", join(dir, "registry.json")] },
      toolCtx,
    );
    assert.match(exported.content[0].text, /exported registry/);
  } finally {
    await execFileAsync(graftdBin, ["stop", "--socket", socket], { timeout: 5_000 }).catch(
      () => undefined,
    );
    if (previousDaemonBin === undefined) delete process.env.GRAFT_DAEMON_BIN;
    else process.env.GRAFT_DAEMON_BIN = previousDaemonBin;
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    if (previousGraftHome === undefined) delete process.env.GRAFT_HOME;
    else process.env.GRAFT_HOME = previousGraftHome;
    await rm(dir, { force: true, recursive: true });
  }
});
