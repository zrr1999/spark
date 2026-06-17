export interface WorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
}

export interface WorkflowJournalEntry {
  index: number;
  hash: string;
  result: unknown;
}

export type WorkflowPhaseStatus = "success" | "fail" | "skip";

export interface WorkflowPhaseOptions {
  status?: WorkflowPhaseStatus;
}

export interface WorkflowPhaseRun {
  title: string;
  status?: WorkflowPhaseStatus;
  startedAt: string;
  finishedAt?: string;
}

export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
  timeoutMs?: number;
  artifactRef?: string;
}

export type WorkflowParallelOnError = "fail-fast" | "collect";

export interface WorkflowParallelRetryOptions {
  attempts?: number;
  backoffMs?: number;
}

export interface WorkflowParallelOptions {
  concurrency?: number;
  retry?: WorkflowParallelRetryOptions;
  onError?: WorkflowParallelOnError;
}

export type WorkflowParallelSettledResult<T> =
  | { status: "fulfilled"; value: T; attempts: number }
  | { status: "rejected"; reason: unknown; attempts: number };

export type WorkflowAgentDeliveryStatus = "delivered" | "non_json_output" | "empty";

export interface WorkflowAgentDeliverySummary {
  status: WorkflowAgentDeliveryStatus;
  message?: string;
}

export interface WorkflowArtifactRecordInput {
  title: string;
  body: string;
  kind?: string;
  format?: string;
  taskRef?: string;
  projectRef?: string;
}

export interface WorkflowArtifactRecordResult {
  ref: string;
}

export type WorkflowArtifactRecorder = (
  input: WorkflowArtifactRecordInput,
) => Promise<WorkflowArtifactRecordResult> | WorkflowArtifactRecordResult;

export interface WorkflowAgentEvent {
  index: number;
  label: string;
  phase?: string;
  prompt: string;
  model?: string;
}

export type WorkflowAgentRunner = (
  prompt: string,
  options: WorkflowAgentOptions & { index: number; phase?: string },
) => Promise<unknown>;

export interface WorkflowRunOptions {
  args?: unknown;
  agent: WorkflowAgentRunner;
  artifactRecord?: WorkflowArtifactRecorder;
  concurrency?: number;
  maxAgents?: number;
  resumeJournal?: Map<number, WorkflowJournalEntry>;
  onAgentJournal?: (entry: WorkflowJournalEntry) => void;
  onPhase?: (phase: WorkflowPhaseRun) => void;
  now?: () => string;
  onAgentStart?: (event: WorkflowAgentEvent) => void;
  onAgentEnd?: (event: WorkflowAgentEvent & { result: unknown }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  phases: WorkflowPhaseRun[];
  agentCount: number;
  journal: WorkflowJournalEntry[];
}
