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

export type SparkWorkflowPhaseStatus = "success" | "fail" | "skip";

export interface SparkWorkflowPhaseOptions {
  status?: SparkWorkflowPhaseStatus;
}

export interface SparkWorkflowPhaseRun {
  title: string;
  status?: SparkWorkflowPhaseStatus;
  startedAt: string;
  finishedAt?: string;
}

export interface SparkWorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
  timeoutMs?: number;
  artifactRef?: string;
}

export type SparkWorkflowParallelOnError = "fail-fast" | "collect";

export interface SparkWorkflowParallelRetryOptions {
  attempts?: number;
  backoffMs?: number;
}

export interface SparkWorkflowParallelOptions {
  concurrency?: number;
  retry?: SparkWorkflowParallelRetryOptions;
  onError?: SparkWorkflowParallelOnError;
}

export type SparkWorkflowParallelSettledResult<T> =
  | { status: "fulfilled"; value: T; attempts: number }
  | { status: "rejected"; reason: unknown; attempts: number };

export type SparkWorkflowAgentDeliveryStatus = "delivered" | "non_json_output" | "empty";

export interface SparkWorkflowAgentDeliverySummary {
  status: SparkWorkflowAgentDeliveryStatus;
  message?: string;
}

export interface SparkWorkflowArtifactRecordInput {
  title: string;
  body: string;
  kind?: string;
  format?: string;
  taskRef?: string;
  projectRef?: string;
}

export interface SparkWorkflowArtifactRecordResult {
  ref: string;
}

export type SparkWorkflowArtifactRecorder = (
  input: SparkWorkflowArtifactRecordInput,
) => Promise<SparkWorkflowArtifactRecordResult> | SparkWorkflowArtifactRecordResult;

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
  artifactRecord?: SparkWorkflowArtifactRecorder;
  concurrency?: number;
  maxAgents?: number;
  resumeJournal?: Map<number, SparkWorkflowJournalEntry>;
  onAgentJournal?: (entry: SparkWorkflowJournalEntry) => void;
  onPhase?: (phase: SparkWorkflowPhaseRun) => void;
  now?: () => string;
  onAgentStart?: (event: SparkWorkflowAgentEvent) => void;
  onAgentEnd?: (event: SparkWorkflowAgentEvent & { result: unknown }) => void;
}

export interface SparkWorkflowRunResult<T = unknown> {
  meta: SparkWorkflowMeta;
  result: T;
  phases: SparkWorkflowPhaseRun[];
  agentCount: number;
  journal: SparkWorkflowJournalEntry[];
}
