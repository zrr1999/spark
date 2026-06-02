import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

void test("pi-graft registers CLI-protocol scratch and candidate controls", () => {
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
      "graft_read",
      "graft_write",
      "graft_edit",
      "graft_delete",
      "graft_status",
      "graft_candidate_from_scratch",
      "graft_validate",
      "graft_admit",
    ],
  );
});

void test("pi-graft rejects unknown doctor arguments before daemon work", async () => {
  const { pi, commands } = createFakePi();
  registerPiGraftExtension(pi);

  const doctor = commands.get("graft-doctor");
  assert.ok(doctor, "expected graft-doctor command to be registered");
  await assert.rejects(
    () => doctor.handler("--unknown", { cwd: "/tmp/pi-graft-no-daemon" }),
    /unknown graft-doctor argument: --unknown/,
  );
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

void test("pi-graft controls real graftd scratch lifecycle through canonical protocol", async (t) => {
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
  const previousGraftHome = process.env.GRAFT_HOME;
  process.env.GRAFT_DAEMON_BIN = graftdBin;
  process.env.GRAFT_HOME = graftHome;
  await mkdir(project, { recursive: true });

  try {
    await execFileAsync(graftBin, ["init"], { cwd: project, timeout: 10_000 });

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
      { scratch: scratchSeed, expected: ["ValidPatch"], message: "pi-graft-seed" },
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
      { scratch: scratchDelete, expected: ["ValidPatch"], message: "pi-graft-candidate" },
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
      { target: candidate, expected: ["ValidPatch"] },
      toolCtx,
    );
    assert.match(validate.content[0].text, /validation completed/);

    const admit = await executeTool(
      tools.get("graft_admit"),
      "graft_admit",
      { candidate, required: ["ValidPatch"] },
      toolCtx,
    );
    assert.match(admit.content[0].text, /admitted|patch/i);

    await commands.get("graft-close")!.handler("", commandCtx);
  } finally {
    await execFileAsync(graftdBin, ["stop", "--socket", socket], { timeout: 5_000 }).catch(
      () => undefined,
    );
    if (previousDaemonBin === undefined) delete process.env.GRAFT_DAEMON_BIN;
    else process.env.GRAFT_DAEMON_BIN = previousDaemonBin;
    if (previousGraftHome === undefined) delete process.env.GRAFT_HOME;
    else process.env.GRAFT_HOME = previousGraftHome;
    await rm(dir, { force: true, recursive: true });
  }
});
