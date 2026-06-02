import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

void test("pi-graft registers the expected local scratch controls", () => {
  const { pi, commands, tools, handlers } = createFakePi();
  registerPiGraftExtension(pi);

  assert.deepEqual([...handlers.keys()], ["session_start"]);
  assert.deepEqual(
    [...commands.keys()],
    ["graft-attach", "graft-detach", "graft-ps", "graft-doctor", "graft-open", "graft-close"],
  );
  assert.deepEqual(
    [...tools.keys()],
    [
      "graft_read",
      "graft_write",
      "graft_edit",
      "graft_status",
      "graft_promote",
      "graft_validate",
      "graft_admit",
    ],
  );
});

void test("pi-graft controls real graftd scratch lifecycle", async (t) => {
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
  await writeFile(join(dir, "placeholder"), "");
  await rm(project, { force: true, recursive: true });
  await execFileAsync("mkdir", ["-p", project]);

  try {
    await execFileAsync(graftBin, ["init"], { cwd: project, timeout: 10_000 });
    const graftTomlPath = join(project, "graft.toml");
    const graftToml = await readFile(graftTomlPath, "utf8");
    await writeFile(
      graftTomlPath,
      graftToml.replace('base_properties = ["ValidPatch"]', "base_properties = []"),
    );
    await writeFile(join(project, "seed.txt"), "seed\n");
    const created = await execFileAsync(
      graftBin,
      ["create", "--from", "graft:empty", "--expect", "ValidPatch", "--message", "pi-graft-base"],
      { cwd: project, timeout: 20_000 },
    );
    const candidate = /candidate:[0-9a-f]+/.exec(created.stdout)?.[0];
    assert.ok(candidate, `expected base candidate in output: ${created.stdout}`);

    const { pi, commands, tools, entries, handlers } = createFakePi();
    registerPiGraftExtension(pi);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, { sessionManager: { getBranch: () => entries } });
    }
    const ctx: PiGraftCommandContext = { cwd: project, ui: { notify() {} } };

    await commands.get("graft-open")!.handler(candidate, ctx);
    assert.ok(entries.length > 0, "opening a scratch persists session state");

    await tools.get("graft_write")!.execute("graft_write", {
      path: "greeting.txt",
      content: "hello\nworld\n",
    });
    const read = await tools.get("graft_read")!.execute("graft_read", { path: "greeting.txt" });
    const readText = read.content[0].text as string;
    const anchor = /^2#[^:]+:world/m.exec(readText)?.[0];
    assert.ok(anchor, `expected hashline anchor for line 2 in ${readText}`);

    const edit = await tools.get("graft_edit")!.execute("graft_edit", {
      path: "greeting.txt",
      edits: [{ op: "replace", pos: anchor, lines: ["graft"] }],
    });
    assert.match(edit.content[0].text, /Updated anchors/);

    const promote = await tools.get("graft_promote")!.execute("promote", {
      expected: [],
      message: "pi-graft-promote",
    });
    const promotedCandidate = requiredString(
      detailsResult(promote).candidate,
      "expected graft_promote details.result.candidate to be a string",
    );
    assert.match(promotedCandidate, /^candidate:[0-9a-f]+$/);

    const validate = await tools.get("graft_validate")!.execute("validate", {
      target: promotedCandidate,
      expected: ["ValidPatch"],
    });
    assert.match(validate.content[0].text, /validation completed/);

    const admit = await tools.get("graft_admit")!.execute("admit", {
      candidate: promotedCandidate,
      required: [],
    });
    assert.match(admit.content[0].text, /admitted|patch/i);

    await commands.get("graft-close")!.handler("", ctx);
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
