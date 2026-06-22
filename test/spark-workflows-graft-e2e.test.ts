import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runWorkflowScript } from "../packages/pi-workflows/src/index.ts";
import {
  createSparkWorkflowRoleRunAdapter,
  SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS,
  type SparkWorkflowGraftAgentResult,
  type SparkWorkflowRoleRunRequest,
} from "../packages/spark-runtime/src/index.ts";
import {
  registerPiGraftExtension,
  type PiGraftExtensionApi,
  type PiGraftToolContext,
  type PiGraftToolDefinition,
  type PiGraftToolResult,
} from "../packages/pi-graft/src/index.ts";

const execFileAsync = promisify(execFile);
const graftRepo = process.env.GRAFT_REPO ?? resolve(process.cwd(), "../graft");
const graftBin = process.env.GRAFT_BIN ?? join(graftRepo, "target/debug/graft");
const graftdBin = process.env.GRAFT_DAEMON_BIN ?? join(graftRepo, "target/debug/graftd");

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") assert.fail(message);
  return value;
}

function detailsResult(result: PiGraftToolResult): Record<string, unknown> {
  const value = result.details?.result;
  assert.ok(isRecord(value), "expected tool details.result to be an object");
  return value;
}

function createFakePiGraftTools() {
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
  registerPiGraftExtension(pi);
  return { tools, entries, handlers };
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

async function binaryAvailable(path: string): Promise<boolean> {
  try {
    await execFileAsync(path, ["--help"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function readCandidateContent(
  candidate: string,
  path: string,
  ctx: PiGraftToolContext,
): Promise<string> {
  const tools = createFakePiGraftTools().tools;
  const read = await executeTool(
    tools.get("graft_read"),
    "graft_read",
    { base: candidate, path },
    ctx,
  );
  return read.content[0].text;
}

function labelFromInstruction(instruction: string): "alpha" | "beta" {
  return instruction.includes("alpha") ? "alpha" : "beta";
}

function assertGraftPolicy(request: SparkWorkflowRoleRunRequest, base: string): void {
  assert.equal(request.env?.GRAFT_BASE_REF, base);
  assert.deepEqual(request.allowedTools, [...SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS]);
  assert.match(request.instruction, /Graft isolation is active/);
  assert.match(request.instruction, /do not use direct read\/write\/edit shell file operations/);
  assert.match(request.instruction, /GRAFT_BASE_REF/);
}

void test("workflow graft isolation E2E creates separate candidates for parallel same-path edits", async (t) => {
  if (process.env.PI_GRAFT_E2E !== "1") {
    t.skip("set PI_GRAFT_E2E=1 to run the real workflow/graft isolation smoke test");
    return;
  }
  if (!(await binaryAvailable(graftBin)) || !(await binaryAvailable(graftdBin))) {
    t.skip(`graft binaries not available at ${graftBin} and ${graftdBin}`);
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "swg-"));
  const project = join(dir, "p");
  const graftHome = join(dir, "gh");
  const socket = join(graftHome, "run", "daemon.sock");
  const previousDaemonBin = process.env.GRAFT_DAEMON_BIN;
  const previousGraftBin = process.env.GRAFT_BIN;
  const previousGraftHome = process.env.GRAFT_HOME;
  const previousGraftBaseRef = process.env.GRAFT_BASE_REF;
  process.env.GRAFT_DAEMON_BIN = graftdBin;
  process.env.GRAFT_BIN = graftBin;
  process.env.GRAFT_HOME = graftHome;
  await mkdir(project, { recursive: true });

  try {
    const seed = createFakePiGraftTools();
    const toolCtx: PiGraftToolContext = {
      cwd: project,
      sessionManager: { getBranch: () => seed.entries },
    };
    for (const handler of seed.handlers.get("session_start") ?? []) await handler({}, toolCtx);
    const seedTools = seed.tools;
    const help = await executeTool(seedTools.get("graft_help"), "graft_help", {}, toolCtx);
    assert.match(help.content[0].text, /Recommended workflow for agents and pi-graft tools/);
    const init = await executeTool(seedTools.get("graft_init"), "graft_init", {}, toolCtx);
    assert.match(init.content[0].text, /initialized|already initialized/);

    const seedWrite = await executeTool(
      seedTools.get("graft_write"),
      "graft_write",
      { base: "graft:empty", path: "same.txt", content: "seed\n" },
      toolCtx,
    );
    const seedScratch = requiredString(
      detailsResult(seedWrite).scratch,
      "expected seed write to return a scratch id",
    );
    const seedCandidateResult = await executeTool(
      seedTools.get("graft_candidate_from_scratch"),
      "graft_candidate_from_scratch",
      { scratch: seedScratch, message: "seed same-path base" },
      toolCtx,
    );
    const seedCandidate = requiredString(
      detailsResult(seedCandidateResult).candidate,
      "expected seed candidate id",
    );
    assert.match(seedCandidate, /^candidate:[0-9a-f]+$/);
    process.env.GRAFT_BASE_REF = seedCandidate;

    const agentRequests: SparkWorkflowRoleRunRequest[] = [];
    const agent = createSparkWorkflowRoleRunAdapter({
      roleRef: "role:workflow-graft-e2e-patcher",
      graftBaseRef: seedCandidate,
      async runRoleInstruction(request) {
        agentRequests.push(request);
        assertGraftPolicy(request, seedCandidate);
        const label = labelFromInstruction(request.instruction);
        const childTools = createFakePiGraftTools().tools;
        const write = await executeTool(
          childTools.get("graft_write"),
          "graft_write",
          { path: "same.txt", content: `${label}\n` },
          toolCtx,
        );
        const scratch = requiredString(
          detailsResult(write).scratch,
          `expected ${label} write to return scratch`,
        );
        const candidateResult = await executeTool(
          childTools.get("graft_candidate_from_scratch"),
          "graft_candidate_from_scratch",
          { scratch, message: `workflow graft isolation ${label}` },
          toolCtx,
        );
        const candidate = requiredString(
          detailsResult(candidateResult).candidate,
          `expected ${label} candidate`,
        );
        const changedPaths = detailsResult(candidateResult).changed_paths;
        assert.ok(Array.isArray(changedPaths), `expected ${label} changed paths`);
        assert.deepEqual(changedPaths, ["same.txt"]);
        return {
          text: `${label}: ${scratch} ${candidate}`,
          structured: { label, scratch, candidate, changedPaths },
        };
      },
    });

    const result = await runWorkflowScript(
      `export const meta = { name: 'graft-e2e', description: 'parallel graft isolation e2e' }
return parallel([
  () => agent('write alpha to same.txt', { isolation: 'graft' }),
  () => agent('write beta to same.txt', { isolation: 'graft' }),
], { concurrency: 2 });`,
      { agent },
    );

    assert.equal(agentRequests.length, 2);
    const outputs = result.result as SparkWorkflowGraftAgentResult[];
    assert.equal(outputs.length, 2);
    const structured = outputs.map((output) => {
      assert.ok(isRecord(output.structured), "expected structured isolated result");
      return output.structured;
    });
    const candidates = structured.map((item) => requiredString(item.candidate, "candidate"));
    const scratches = structured.map((item) => requiredString(item.scratch, "scratch"));
    assert.equal(new Set(candidates).size, 2, "parallel edits must produce distinct candidates");
    assert.equal(new Set(scratches).size, 2, "parallel edits must produce distinct scratches");
    outputs.forEach((output, index) => {
      assert.deepEqual(output.graftRefs.candidateRefs.sort(), [
        requiredString(structured[index]?.candidate, "candidate"),
      ]);
      assert.deepEqual(output.graftRefs.scratchRefs.sort(), [
        requiredString(structured[index]?.scratch, "scratch"),
      ]);
    });

    const byLabel = new Map(
      structured.map((item) => [
        requiredString(item.label, "label"),
        requiredString(item.candidate, "candidate"),
      ]),
    );
    assert.match(
      await readCandidateContent(
        requiredString(byLabel.get("alpha"), "alpha candidate"),
        "same.txt",
        toolCtx,
      ),
      /alpha/,
    );
    assert.match(
      await readCandidateContent(
        requiredString(byLabel.get("beta"), "beta candidate"),
        "same.txt",
        toolCtx,
      ),
      /beta/,
    );
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
    if (previousGraftBaseRef === undefined) delete process.env.GRAFT_BASE_REF;
    else process.env.GRAFT_BASE_REF = previousGraftBaseRef;
    await rm(dir, { force: true, recursive: true });
  }
});
