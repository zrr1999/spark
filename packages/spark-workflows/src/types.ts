export interface SparkWorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface SparkWorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: SparkWorkflowPhase[];
}

export interface SparkWorkflowJournalEntry {
  index: number;
  hash: string;
  result: unknown;
}

export interface SparkWorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
  timeoutMs?: number;
}

export interface SparkWorkflowAgentEvent {
  index: number;
  label: string;
  phase?: string;
  prompt: string;
  model?: string;
}

export type SparkWorkflowAgentRunner = (
  prompt: string,
  options: SparkWorkflowAgentOptions & { index: number; phase?: string },
) => Promise<unknown>;

export interface SparkWorkflowRunOptions {
  args?: unknown;
  agent: SparkWorkflowAgentRunner;
  concurrency?: number;
  maxAgents?: number;
  resumeJournal?: Map<number, SparkWorkflowJournalEntry>;
  onAgentJournal?: (entry: SparkWorkflowJournalEntry) => void;
  onPhase?: (phase: string) => void;
  onAgentStart?: (event: SparkWorkflowAgentEvent) => void;
  onAgentEnd?: (event: SparkWorkflowAgentEvent & { result: unknown }) => void;
}

export interface SparkWorkflowRunResult<T = unknown> {
  meta: SparkWorkflowMeta;
  result: T;
  phases: string[];
  agentCount: number;
  journal: SparkWorkflowJournalEntry[];
}
