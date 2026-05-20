import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type AgentRef,
  type AgentSpec,
  type AgentSpecProposal,
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
      "You are a Spark scout. Gather context, identify relevant files and risks, do not edit files, use Spark ask tools for real ambiguities/blockers instead of only listing questions when a user decision is needed, and flag obviously placeholder/generic/stale Spark thread or task names so they can be safely improved without changing refs.",
      now,
    ),
    builtin(
      "planner",
      "Turns context into concrete task plans.",
      "You are a Spark planner. Produce concrete plans and dependencies without editing files, use Spark ask tools for real ambiguities/blockers instead of only listing questions when a user decision is needed, treat user-reported repo behavior changes as implementation work rather than memory-only updates, and improve obviously placeholder/generic/stale Spark thread or task display names only when the new name is clear and refs stay stable.",
      now,
    ),
    builtin(
      "worker",
      "Executes approved implementation tasks.",
      "You are a Spark worker. Implement only the assigned instruction, use Spark ask tools for blockers or missing requirements instead of only reporting questions, and when the user reports a concrete repo behavior change, fix the implementation instead of only recording a preference. Safely improve obviously placeholder/generic/stale Spark thread or claimed-task @name/title when the current intent makes the better name clear while preserving refs and intentional user names.",
      now,
    ),
    builtin(
      "reviewer",
      "Reviews results and artifacts against task intent.",
      "You are a Spark reviewer. Verify claims from fresh context, return actionable findings, use Spark ask tools for blocking ambiguous intent instead of silently assuming it, and call out placeholder/generic/stale Spark thread or task names only when a safe improvement is obvious and would preserve refs.",
      now,
    ),
    builtin(
      "oracle",
      "Challenges risky decisions before execution.",
      "You are a Spark oracle. Challenge assumptions, use Spark ask tools for missing blocking decisions when a concrete user choice is required, recommend the safest next move without editing files, and preserve intentional Spark thread/task names unless a placeholder/generic/stale rename is plainly correct and ref-safe.",
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
    source: "predefined",
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

export class ProjectAgentSpecStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async save(agent: AgentSpec): Promise<void> {
    validateAgentSpec(agent);
    if (agent.source !== "project")
      throw new Error("only project agent specs can be saved to ProjectAgentSpecStore");
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.pathFor(agent.ref), `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  }

  async loadAll(): Promise<AgentSpec[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const agents: AgentSpec[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      agents.push(
        normalizeStoredAgentSpec(
          JSON.parse(await readFile(join(this.rootDir, entry.name), "utf8")),
        ),
      );
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

export function defaultProjectAgentSpecStore(cwd: string): ProjectAgentSpecStore {
  return new ProjectAgentSpecStore(join(cwd, ".spark", "agents"));
}

export function createAgentSpec(proposal: AgentSpecProposal, now = nowIso()): AgentSpec {
  return {
    ref: newRef("agent", `project-${stableId(proposal.id)}`),
    id: proposal.id,
    source: proposal.source ?? "project",
    description: proposal.description,
    systemPrompt: proposal.systemPrompt,
    allowedTools: proposal.allowedTools,
    defaultModel: proposal.defaultModel,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeStoredAgentSpec(raw: unknown): AgentSpec {
  const candidate = raw as Omit<AgentSpec, "source"> & { scope?: string; source?: string };
  if (!candidate.source && candidate.scope === "managed") {
    return { ...candidate, source: "project" };
  }
  if (candidate.source === "builtin") return { ...candidate, source: "predefined" };
  return candidate as AgentSpec;
}

export { ProjectAgentSpecStore as ManagedAgentStore };

export function defaultManagedAgentStore(cwd: string): ProjectAgentSpecStore {
  return defaultProjectAgentSpecStore(cwd);
}

export function createManagedAgentSpec(proposal: AgentSpecProposal, now = nowIso()): AgentSpec {
  return createAgentSpec(proposal, now);
}
