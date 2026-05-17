import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  type AgentInstruction,
  type AgentRef,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentSpec,
  type ManagedAgentProposal,
  type RunRef,
  newRef,
  nowIso,
  refId,
  stableId,
  validateAgentSpec,
} from "spark-core";

export const builtinAgentIds = ["scout", "planner", "worker", "reviewer", "oracle"] as const;
export type BuiltinAgentId = (typeof builtinAgentIds)[number];

export function builtinAgentRef(id: BuiltinAgentId): AgentRef {
  return `agent:builtin-${id}` as AgentRef;
}

export function createBuiltinAgents(now = nowIso()): AgentSpec[] {
  return [
    builtin(
      "scout",
      "Fast repo and context reconnaissance.",
      "You are a Spark scout. Gather context, identify relevant files and risks, do not edit files, and surface clarifying questions instead of inferring missing intent.",
      now,
    ),
    builtin(
      "planner",
      "Turns context into concrete task plans.",
      "You are a Spark planner. Produce concrete plans and dependencies without editing files, turn ambiguity into explicit clarification needs instead of guessing, and treat user-reported repo behavior changes as implementation work rather than memory-only updates.",
      now,
    ),
    builtin(
      "worker",
      "Executes approved implementation tasks.",
      "You are a Spark worker. Implement only the assigned instruction, surface blockers, ask for clarification instead of guessing missing requirements, and when the user reports a concrete repo behavior change, fix the implementation instead of only recording a preference.",
      now,
    ),
    builtin(
      "reviewer",
      "Reviews results and artifacts against task intent.",
      "You are a Spark reviewer. Verify claims from fresh context, return actionable findings, and call out ambiguous intent instead of silently assuming it.",
      now,
    ),
    builtin(
      "oracle",
      "Challenges risky decisions before execution.",
      "You are a Spark oracle. Challenge assumptions, surface missing decisions, and recommend the safest next move without editing files.",
      now,
    ),
  ];
}

function builtin(
  id: BuiltinAgentId,
  description: string,
  systemPrompt: string,
  now: string,
): AgentSpec {
  return {
    ref: builtinAgentRef(id),
    id,
    scope: "builtin",
    description,
    systemPrompt,
    createdAt: now,
    updatedAt: now,
  };
}

export class AgentRegistry {
  #agents = new Map<AgentRef, AgentSpec>();

  constructor(initialAgents: AgentSpec[] = createBuiltinAgents()) {
    for (const agent of initialAgents) this.add(agent);
  }

  add(agent: AgentSpec): void {
    validateAgentSpec(agent);
    this.#agents.set(agent.ref, agent);
  }

  get(ref: AgentRef): AgentSpec {
    const agent = this.#agents.get(ref);
    if (!agent) throw new Error(`unknown agent: ${ref}`);
    return agent;
  }

  has(ref: AgentRef): boolean {
    return this.#agents.has(ref);
  }

  list(): AgentSpec[] {
    return [...this.#agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  select(idOrRef: string): AgentSpec {
    if (idOrRef.startsWith("agent:")) return this.get(idOrRef as AgentRef);
    const matches = this.list().filter(
      (agent) => agent.id === idOrRef || refId(agent.ref) === idOrRef,
    );
    if (matches.length === 0) throw new Error(`no agent matches: ${idOrRef}`);
    if (matches.length > 1) throw new Error(`ambiguous agent: ${idOrRef}`);
    return matches[0];
  }
}

export class ManagedAgentStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async save(agent: AgentSpec): Promise<void> {
    validateAgentSpec(agent);
    if (agent.scope !== "managed")
      throw new Error("only managed agents can be saved to ManagedAgentStore");
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.pathFor(agent.ref), `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  }

  async loadAll(): Promise<AgentSpec[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const agents: AgentSpec[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      agents.push(JSON.parse(await readFile(join(this.rootDir, entry.name), "utf8")) as AgentSpec);
    }
    return agents;
  }

  async hydrate(registry: AgentRegistry): Promise<void> {
    for (const agent of await this.loadAll()) registry.add(agent);
  }

  pathFor(ref: AgentRef): string {
    return join(this.rootDir, `${refId(ref)}.json`);
  }
}

export function defaultManagedAgentStore(cwd: string): ManagedAgentStore {
  return new ManagedAgentStore(join(cwd, ".spark", "agents"));
}

export function createManagedAgentSpec(proposal: ManagedAgentProposal, now = nowIso()): AgentSpec {
  return {
    ref: newRef("agent", `managed-${stableId(proposal.id)}`),
    id: proposal.id,
    scope: "managed",
    description: proposal.description,
    systemPrompt: proposal.systemPrompt,
    createdAt: now,
    updatedAt: now,
  };
}

export interface AgentRunResult {
  record: AgentRunRecord;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface AgentRunnerOptions {
  cwd: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  sessionDir?: string;
}

export async function runAgentInstructionOnly(
  registry: AgentRegistry,
  instruction: AgentInstruction,
  options: Partial<AgentRunnerOptions> = {},
): Promise<AgentRunResult> {
  const agent = registry.get(instruction.agentRef);
  if (!instruction.instruction.trim()) throw new Error("agent instruction is required");
  const startedAt = nowIso();
  const baseRecord: AgentRunRecord = {
    ref: newRef("run"),
    agentRef: agent.ref,
    instruction: instruction.instruction,
    status: (options.dryRun ?? true) ? "not_started" : "running",
    startedAt,
  };

  if (options.dryRun ?? true) {
    return {
      record: { ...baseRecord, status: "not_started", finishedAt: nowIso() },
      stdout: "",
      stderr: "",
      jsonEvents: [],
    };
  }

  return runPiJsonAgent(
    agent,
    instruction,
    {
      cwd: options.cwd ?? process.cwd(),
      piCommand: options.piCommand ?? "pi",
      timeoutMs: options.timeoutMs ?? 600_000,
      sessionDir: options.sessionDir,
    },
    baseRecord.ref,
  );
}

export function parseJsonlEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Pi may emit non-JSON diagnostics. Keep parser tolerant.
    }
  }
  return events;
}

async function runPiJsonAgent(
  agent: AgentSpec,
  instruction: AgentInstruction,
  options: Required<Pick<AgentRunnerOptions, "cwd" | "piCommand" | "timeoutMs">> &
    Pick<AgentRunnerOptions, "sessionDir">,
  runRef: RunRef,
): Promise<AgentRunResult> {
  const prompt = [agent.systemPrompt, "", "Instruction:", instruction.instruction].join("\n");
  const args = ["--mode", "json", "--prompt", prompt];
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);

  const startedAt = nowIso();
  const child = spawn(options.piCommand, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent run timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const status: AgentRunStatus = exitCode === 0 ? "succeeded" : "failed";
  return {
    record: {
      ref: runRef,
      agentRef: agent.ref,
      instruction: instruction.instruction,
      status,
      startedAt,
      finishedAt: nowIso(),
    },
    stdout,
    stderr,
    jsonEvents: parseJsonlEvents(stdout),
  };
}
