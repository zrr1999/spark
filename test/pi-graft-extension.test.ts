import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  registerPiGraftExtension,
  type PiGraftCommand,
  type PiGraftCommandContext,
  type PiGraftExtensionApi,
  type PiGraftSessionContext,
  type PiGraftToolContext,
  type PiGraftToolDefinition,
  type PiGraftToolResult,
} from "../packages/pi-graft/src/index.ts";

const execFileAsync = promisify(execFile);
const graftRepo = process.env.GRAFT_REPO ?? resolve(process.cwd(), "../graft");
const graftBin = process.env.GRAFT_BIN ?? join(graftRepo, "target/debug/graft");
const graftdBin = process.env.GRAFT_DAEMON_BIN ?? join(graftRepo, "target/debug/graftd");
const testTmpRoot = resolve(process.cwd(), ".test-tmp");

type EnvBackup = Record<string, string | undefined>;

function restoreEnv(backup: EnvBackup): void {
  for (const [name, value] of Object.entries(backup)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function createTestDir(prefix: string): Promise<string> {
  await mkdir(testTmpRoot, { mode: 0o700, recursive: true });
  return mkdtemp(join(testTmpRoot, `${prefix}-`));
}

async function binaryAvailable(path: string): Promise<boolean> {
  try {
    await execFileAsync(path, ["--help"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

type SessionStartHandler = (event: unknown, ctx: PiGraftSessionContext) => unknown;

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
  const commands = new Map<string, PiGraftCommand>();
  const tools = new Map<string, PiGraftToolDefinition>();
  const entries: unknown[] = [];
  const handlers = new Map<"session_start", SessionStartHandler[]>();
  const pi: PiGraftExtensionApi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  return { pi, commands, tools, entries, handlers };
}

async function writeMockGraft(dir: string, scriptBody: string): Promise<string> {
  const path = join(dir, "graft-mock");
  await writeFile(path, `#!/bin/sh\n${scriptBody}\n`);
  await chmod(path, 0o755);
  return path;
}

type MockGraftContext = {
  argvFile: string;
  dir: string;
  project: string;
};

async function withMockGraft(
  prefix: string,
  scriptBody: string,
  run: (context: MockGraftContext) => Promise<void>,
): Promise<void> {
  const dir = await createTestDir(prefix);
  const context = { argvFile: join(dir, "argv.txt"), dir, project: join(dir, "project") };
  const envBackup: EnvBackup = {
    GRAFT_BIN: process.env.GRAFT_BIN,
    PI_GRAFT_MOCK_ARGV: process.env.PI_GRAFT_MOCK_ARGV,
  };
  process.env.PI_GRAFT_MOCK_ARGV = context.argvFile;
  process.env.GRAFT_BIN = await writeMockGraft(dir, scriptBody);

  try {
    await run(context);
  } finally {
    restoreEnv(envBackup);
    await rm(dir, { force: true, recursive: true });
  }
}

type MockGraftdRequest = {
  id: string;
  op: string;
  params: Record<string, unknown>;
};

async function withMockGraftd(
  handler: (request: MockGraftdRequest) => Record<string, unknown>,
  run: (home: string) => Promise<void>,
): Promise<void> {
  const dir = await createTestDir("pi-graftd-mock");
  const home = join(".test-tmp", basename(dir), "home");
  const socketPath = join(home, "run", "daemon.sock");
  await mkdir(join(home, "run"), { recursive: true });
  const server = net.createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      const request = JSON.parse(line) as MockGraftdRequest;
      const response = handler(request);
      socket.write(`${JSON.stringify(response)}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    await run(home);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { force: true, recursive: true });
  }
}

type RoutedMockGraftdContext = ReturnType<typeof createFakePi> & {
  project: string;
};

async function withRoutedMockGraftd(
  projectName: string,
  workspaceId: string | undefined,
  handler: (request: MockGraftdRequest, project: string) => Record<string, unknown>,
  run: (context: RoutedMockGraftdContext) => Promise<void>,
): Promise<void> {
  const project = join(testTmpRoot, projectName);
  const envBackup: EnvBackup = {
    GRAFT_HOME: process.env.GRAFT_HOME,
    GRAFT_WORKSPACE: process.env.GRAFT_WORKSPACE,
  };

  try {
    await withMockGraftd(
      (request) => handler(request, project),
      async (home) => {
        process.env.GRAFT_HOME = home;
        if (workspaceId === undefined) delete process.env.GRAFT_WORKSPACE;
        else process.env.GRAFT_WORKSPACE = workspaceId;
        const fakePi = createFakePi();
        registerPiGraftExtension(fakePi.pi);
        await run({ ...fakePi, project });
      },
    );
  } finally {
    restoreEnv(envBackup);
  }
}

await test("pi-graft registers the final high-frequency direct tool set", () => {
  const { pi, commands, tools, handlers } = createFakePi();
  registerPiGraftExtension(pi);

  assert.deepEqual([...handlers.keys()], ["session_start"]);
  assert.deepEqual(
    [...commands.keys()],
    ["graft-attach", "graft-detach", "graft-ps", "graft-doctor", "graft-close"],
  );
  assert.deepEqual(
    [...tools.keys()],
    [
      "graft_patch",
      "graft_help",
      "graft_init",
      "graft_status",
      "graft_ps",
      "graft_doctor",
      "graft_read",
      "graft_write",
      "graft_edit",
      "graft_delete",
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

await test("graft_help defaults to the maintained agent workflow topic", async () => {
  await withMockGraft(
    "pi-graft-help",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\necho 'Recommended workflow for agents and pi-graft tools'`,
    async ({ argvFile, dir }) => {
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
    },
  );
});

await test("graft_cli_exec validates argv before daemon work", async () => {
  const { pi, tools } = createFakePi();
  registerPiGraftExtension(pi);
  const cliExec = tools.get("graft_cli_exec");
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: [] },
        { cwd: join(testTmpRoot, "pi-graft-no-daemon") },
      ),
    /argv must be a non-empty string array/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: "status" },
        { cwd: join(testTmpRoot, "pi-graft-no-daemon") },
      ),
    /argv must be a string array/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: ["status", 1] },
        { cwd: join(testTmpRoot, "pi-graft-no-daemon") },
      ),
    /argv\[1] must be a string/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: ["property", "list"] },
        { cwd: join(testTmpRoot, "pi-graft-no-daemon") },
      ),
    /does not allow graft property/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: ["scratch", "read", "--base", "graft:empty", "note.txt"] },
        { cwd: join(testTmpRoot, "pi-graft-no-daemon") },
      ),
    /does not allow graft scratch/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: ["incoming"] },
        { cwd: join(testTmpRoot, "pi-graft-no-daemon") },
      ),
    /does not allow graft incoming/,
  );
  await assert.rejects(
    () =>
      executeTool(
        cliExec,
        "graft_cli_exec",
        { argv: ["patch", "materialize", "patch:abc"] },
        { cwd: join(testTmpRoot, "pi-graft-no-daemon") },
      ),
    /does not allow graft patch materialize/,
  );
});

await test("graft_cli_exec description advertises canonical patch incoming", () => {
  const { pi, tools } = createFakePi();
  registerPiGraftExtension(pi);
  const cliExec = tools.get("graft_cli_exec");
  assert.ok(cliExec, "expected graft_cli_exec tool to be registered");

  assert.match(cliExec.description, /patch incoming\/list\/show\/search/);
  assert.doesNotMatch(cliExec.description, /explain\/incoming\/sync/);
  assert.doesNotMatch(cliExec.description, /materialize/);
});

await test("graft_cli_exec routes canonical patch incoming through direct CLI", async () => {
  await withMockGraft(
    "pi-graft-patch-incoming",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\nprintf '{"message":"incoming groups"}\\n'`,
    async ({ argvFile, dir }) => {
      const { pi, tools } = createFakePi();
      registerPiGraftExtension(pi);
      const result = await executeTool(
        tools.get("graft_cli_exec"),
        "graft_cli_exec",
        { argv: ["patch", "incoming"] },
        { cwd: dir },
      );
      assert.match(result.content[0].text, /incoming groups/);
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        dir,
        "patch",
        "incoming",
      ]);
    },
  );
});

await test("graft_cli_exec allows low-frequency patch promote argv", async () => {
  await withRoutedMockGraftd(
    "pi-graft-promote-workspace",
    "ws:promote",
    (request, project) => {
      assert.equal(request.op, "cli_exec");
      assert.equal(request.params.workspace_id, "ws:promote");
      assert.equal(request.params.workspace_root, project);
      assert.deepEqual(request.params.argv, [
        "graft",
        "--cwd",
        project,
        "patch",
        "promote",
        "patch:abc",
        "--to",
        "review",
        "--yes",
      ]);
      return { id: request.id, ok: true, result: { message: "promoted" } };
    },
    async ({ project, tools }) => {
      const result = await executeTool(
        tools.get("graft_cli_exec"),
        "graft_cli_exec",
        { argv: ["patch", "promote", "patch:abc", "--to", "review", "--yes"] },
        { cwd: project },
      );
      assert.match(result.content[0].text, /promoted/);
    },
  );
});

await test("graft-attach --status uses canonical workspace attach route", async () => {
  await withMockGraft(
    "pi-graft-attach-status",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\nprintf '{"message":"attach status"}\\n'`,
    async ({ argvFile, dir }) => {
      const { pi, commands } = createFakePi();
      registerPiGraftExtension(pi);
      const attach = commands.get("graft-attach");
      assert.ok(attach, "expected graft-attach command to be registered");
      const notifications: string[] = [];
      await attach.handler("--status", {
        cwd: dir,
        ui: {
          notify(message) {
            notifications.push(message);
          },
        },
      });
      assert.deepEqual(notifications, ["attach status"]);
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        dir,
        "workspace",
        "attach",
        "--status",
      ]);
    },
  );
});

await test("graft-ps command uses the direct CLI route", async () => {
  await withMockGraft(
    "pi-graft-ps",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\nprintf '{"message":"ps direct"}\\n'`,
    async ({ argvFile, dir }) => {
      const { pi, commands } = createFakePi();
      registerPiGraftExtension(pi);
      const ps = commands.get("graft-ps");
      assert.ok(ps, "expected graft-ps command to be registered");
      const notifications: string[] = [];
      await ps.handler("", {
        cwd: dir,
        ui: {
          notify(message) {
            notifications.push(message);
          },
        },
      });
      assert.deepEqual(notifications, ["ps direct"]);
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        dir,
        "workspace",
        "ps",
      ]);
    },
  );
});

await test("graft_init uses direct CLI bootstrap path", async () => {
  await withMockGraft(
    "pi-graft-init",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\nprintf '{"status":"ok","message":"initialized mock"}\\n'`,
    async ({ argvFile, project }) => {
      await mkdir(project, { recursive: true });
      const { pi, tools } = createFakePi();
      registerPiGraftExtension(pi);
      const init = tools.get("graft_init");
      assert.ok(init, "expected graft_init to be registered");
      const result = await init.execute("graft_init", { cwd: project });
      assert.match(result.content[0].text, /initialized mock/);
      assert.deepEqual(result.details?.envelope, { status: "ok", message: "initialized mock" });
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        project,
        "--json",
        "workspace",
        "init",
      ]);
    },
  );
});

await test("pi-graft rejects unknown doctor arguments before daemon work", async () => {
  const { pi, commands } = createFakePi();
  registerPiGraftExtension(pi);

  const doctor = commands.get("graft-doctor");
  assert.ok(doctor, "expected graft-doctor command to be registered");
  await assert.rejects(
    () => doctor.handler("--unknown", { cwd: join(testTmpRoot, "pi-graft-no-daemon") }),
    /unknown graft-doctor argument: --unknown/,
  );
});

await test("pi-graft tools require explicit cwd or restored session state", async () => {
  const { pi, tools } = createFakePi();
  registerPiGraftExtension(pi);

  const status = tools.get("graft_status");
  assert.ok(status, "expected graft_status tool to be registered");
  await assert.rejects(
    () => status.execute("graft_status", {}),
    /pi-graft tools require a cwd context or restored session state/,
  );
});

await test("pi-graft routed daemon requests use workspace_root, not cwd", async () => {
  await withRoutedMockGraftd(
    "pi-graft-routed-workspace",
    "ws:test",
    (request, project) => {
      assert.equal(request.op, "cli_exec");
      assert.equal(request.params.workspace_id, "ws:test");
      assert.equal(request.params.workspace_root, project);
      assert.equal("cwd" in request.params, false);
      assert.deepEqual(request.params.argv, [
        "graft",
        "--cwd",
        project,
        "patch",
        "validate",
        "candidate:abc",
      ]);
      return { id: request.id, ok: true, result: { message: "validation completed" } };
    },
    async ({ project, tools }) => {
      const result = await executeTool(
        tools.get("graft_validate"),
        "graft_validate",
        { target: "candidate:abc" },
        { cwd: project },
      );
      assert.match(result.content[0].text, /validation completed/);
    },
  );
});

await test("graft_admit uses canonical patch namespace over daemon route", async () => {
  await withRoutedMockGraftd(
    "pi-graft-admit-workspace",
    "ws:admit",
    (request, project) => {
      assert.equal(request.op, "cli_exec");
      assert.equal(request.params.workspace_id, "ws:admit");
      assert.equal(request.params.workspace_root, project);
      assert.deepEqual(request.params.argv, [
        "graft",
        "--cwd",
        project,
        "patch",
        "admit",
        "candidate:abc",
        "--require",
        "tests_pass",
      ]);
      return { id: request.id, ok: true, result: { message: "admitted", patch_id: "patch:def" } };
    },
    async ({ project, tools }) => {
      const result = await executeTool(
        tools.get("graft_admit"),
        "graft_admit",
        { candidate: "candidate:abc", required: ["tests_pass"] },
        { cwd: project },
      );
      assert.match(result.content[0].text, /admitted/);
    },
  );
});

await test("graft_status uses the global daemon status op without routing fields", async () => {
  await withRoutedMockGraftd(
    "pi-graft-status-workspace",
    undefined,
    (request) => {
      assert.equal(request.op, "status");
      assert.deepEqual(request.params, {});
      return { id: request.id, ok: true, result: { status: "ok", daemon: "graftd" } };
    },
    async ({ project, tools }) => {
      const result = await executeTool(
        tools.get("graft_status"),
        "graft_status",
        {},
        { cwd: project },
      );
      assert.match(result.content[0].text, /graftd: ok/);
    },
  );
});

await test("graft_repo list uses the direct CLI route", async () => {
  await withMockGraft(
    "pi-graft-repo-list",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\nprintf 'spark\\tpresent\\t.graft/repos/spark\\tlocal\\n'`,
    async ({ argvFile, dir }) => {
      const { pi, tools } = createFakePi();
      registerPiGraftExtension(pi);
      const result = await executeTool(
        tools.get("graft_repo"),
        "graft_repo",
        { action: "list" },
        { cwd: dir },
      );
      assert.match(result.content[0].text, /spark/);
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        dir,
        "repo",
        "list",
      ]);
    },
  );
});

await test("graft lifecycle schemas describe constraints, not properties", () => {
  const { pi, tools } = createFakePi();
  registerPiGraftExtension(pi);
  const candidateFromScratch = tools.get("graft_candidate_from_scratch");
  const validate = tools.get("graft_validate");
  const admit = tools.get("graft_admit");
  const search = tools.get("graft_search");
  assert.ok(candidateFromScratch, "expected graft_candidate_from_scratch to be registered");
  assert.ok(validate, "expected graft_validate to be registered");
  assert.ok(admit, "expected graft_admit to be registered");
  assert.ok(search, "expected graft_search to be registered");

  const candidateProperties = (
    candidateFromScratch.parameters as { properties: Record<string, any> }
  ).properties;
  const validateProperties = (validate.parameters as { properties: Record<string, any> })
    .properties;
  const admitProperties = (admit.parameters as { properties: Record<string, any> }).properties;
  const searchProperties = (search.parameters as { properties: Record<string, any> }).properties;

  assert.match(candidateProperties.expected.items.description, /constraint primitive/);
  assert.match(validateProperties.expected.items.description, /constraint primitive/);
  assert.match(admitProperties.required.items.description, /constraint primitive/);
  assert.match(searchProperties.hasEvidence.description, /whole-state constraint/);
  assert.doesNotMatch(candidateProperties.expected.items.description, /property/i);
  assert.doesNotMatch(validateProperties.expected.items.description, /property/i);
  assert.doesNotMatch(admitProperties.required.items.description, /property/i);
  assert.doesNotMatch(searchProperties.hasEvidence.description, /property/i);
});

await test("graft candidate and search filters use current constraint argv", async () => {
  await withMockGraft(
    "pi-graft-constraint-filter",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\necho 'filtered'`,
    async ({ argvFile, project }) => {
      await mkdir(project, { recursive: true });
      const { pi, tools } = createFakePi();
      registerPiGraftExtension(pi);
      const candidates = tools.get("graft_candidates");
      const search = tools.get("graft_search");
      assert.ok(candidates, "expected graft_candidates to be registered");
      assert.ok(search, "expected graft_search to be registered");
      const candidateProperties = (candidates.parameters as { properties: Record<string, unknown> })
        .properties;
      const searchProperties = (search.parameters as { properties: Record<string, unknown> })
        .properties;
      assert.ok("constraint" in candidateProperties);
      assert.ok("constraint" in searchProperties);
      assert.equal("property" in candidateProperties, false);
      assert.equal("property" in searchProperties, false);

      await executeTool(
        candidates,
        "graft_candidates",
        { constraint: "tests_pass", failed: true, producer: "pi-graft" },
        { cwd: project },
      );
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        project,
        "--json",
        "candidates",
        "--constraint",
        "tests_pass",
        "--failed",
        "--producer",
        "pi-graft",
      ]);

      await executeTool(
        search,
        "graft_search",
        { constraint: "tests_pass", base: "graft:empty", hasEvidence: "tests_pass" },
        { cwd: project },
      );
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        project,
        "--json",
        "patch",
        "search",
        "--constraint",
        "tests_pass",
        "--base",
        "graft:empty",
        "--has-evidence",
        "tests_pass",
      ]);

      await assert.rejects(
        () =>
          executeTool(candidates, "graft_candidates", { property: "tests_pass" }, { cwd: project }),
        /property was renamed to constraint/,
      );
      await assert.rejects(
        () => executeTool(search, "graft_search", { property: "tests_pass" }, { cwd: project }),
        /property was renamed to constraint/,
      );
    },
  );
});

await test("graft_show uses canonical patch namespace over direct CLI route", async () => {
  await withMockGraft(
    "pi-graft-show",
    `printf '%s\\n' "$@" > "$PI_GRAFT_MOCK_ARGV"\necho 'shown'`,
    async ({ argvFile, project }) => {
      await mkdir(project, { recursive: true });
      const { pi, tools } = createFakePi();
      registerPiGraftExtension(pi);
      const result = await executeTool(
        tools.get("graft_show"),
        "graft_show",
        { target: "patch:abc", evidence: true, change: true },
        { cwd: project },
      );
      assert.match(result.content[0].text, /shown/);
      assert.deepEqual((await readFile(argvFile, "utf8")).trim().split("\n"), [
        "--cwd",
        project,
        "--json",
        "patch",
        "show",
        "patch:abc",
        "--evidence",
        "--change",
      ]);
    },
  );
});

await test("graft_materialize schema and argv match current graft CLI", async () => {
  await withRoutedMockGraftd(
    "pi-graft-materialize-workspace",
    "ws:materialize",
    (request, project) => {
      assert.equal(request.op, "cli_exec");
      assert.equal(request.params.workspace_id, "ws:materialize");
      assert.equal(request.params.workspace_root, project);
      assert.deepEqual(request.params.argv, [
        "graft",
        "--cwd",
        project,
        "patch",
        "materialize",
        "patch:abc",
        "--dry-run",
      ]);
      return { id: request.id, ok: true, result: { message: "materialization dry-run ready" } };
    },
    async ({ project, tools }) => {
      const materialize = tools.get("graft_materialize");
      assert.ok(materialize, "expected graft_materialize to be registered");
      const schema = JSON.stringify(materialize.parameters);
      assert.doesNotMatch(schema, /asCommit|as-commit|"ref"|--ref/);

      const result = await executeTool(
        materialize,
        "graft_materialize",
        { patch: "patch:abc" },
        { cwd: project },
      );
      assert.match(result.content[0].text, /materialization dry-run ready/);
    },
  );
});

await test("graft_repo add uses daemon-owned cli_exec routing", async () => {
  await withRoutedMockGraftd(
    "pi-graft-repo-add-workspace",
    "ws:repo",
    (request, project) => {
      assert.equal(request.op, "cli_exec");
      assert.equal(request.params.workspace_id, "ws:repo");
      assert.equal(request.params.workspace_root, project);
      assert.deepEqual(request.params.argv, [
        "graft",
        "--cwd",
        project,
        "repo",
        "add",
        "spark",
        "/repos/spark",
        "--default-branch",
        "main",
      ]);
      return { id: request.id, ok: true, result: { message: "added repo spark" } };
    },
    async ({ project, tools }) => {
      const result = await executeTool(
        tools.get("graft_repo"),
        "graft_repo",
        {
          action: "add",
          repoId: "spark",
          url: "/repos/spark",
          defaultBranch: "main",
        },
        { cwd: project },
      );
      assert.match(result.content[0].text, /added repo spark/);
    },
  );
});

await test("pi-graft controls real graftd scratch lifecycle through canonical protocol", async (t) => {
  if (process.env.PI_GRAFT_E2E !== "1") {
    t.skip("set PI_GRAFT_E2E=1 to run the real graftd scratch lifecycle test");
    return;
  }
  if (!(await binaryAvailable(graftBin)) || !(await binaryAvailable(graftdBin))) {
    t.skip(`graft binaries not available at ${graftBin} and ${graftdBin}`);
    return;
  }

  const dir = await createTestDir("pi-graft-e2e");
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
    const { pi, commands, tools, entries, handlers } = createFakePi();
    registerPiGraftExtension(pi);
    const toolCtx: PiGraftToolContext = {
      cwd: project,
      sessionManager: { getBranch: () => entries },
    };
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, toolCtx);
    }
    const commandCtx: PiGraftCommandContext = { cwd: project, ui: { notify() {} } };

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
      { argv: ["bundle", "export", join(dir, "registry.json")] },
      toolCtx,
    );
    assert.match(exported.content[0].text, /exported registry/);

    await commands.get("graft-close")!.handler("", commandCtx);
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
