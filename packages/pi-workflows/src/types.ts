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
  /** Soft token ceiling for work started while this phase is current. */
  budget?: number;
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
  isolation?: "graft";
  agentType?: string;
  timeoutMs?: number;
  artifactRef?: string;
  env?: Record<string, string | undefined>;
  allowedTools?: string[];
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

export interface WorkflowWebSearchInput {
  query?: string;
  queries?: string[];
  numResults?: number;
  includeContent?: boolean;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
}

export interface WorkflowFetchContentInput {
  url: string;
  prompt?: string;
}

export type WorkflowWebSearchAdapter = (input: WorkflowWebSearchInput) => unknown;
export type WorkflowFetchContentAdapter = (input: WorkflowFetchContentInput) => unknown;

export interface WorkflowAgentEvent {
  index: number;
  label: string;
  phase?: string;
  prompt: string;
  model?: string;
}

export type WorkflowAgentTokenUsageSource = "actual" | "estimated";

export interface WorkflowAgentReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
  provider?: string;
}

export interface WorkflowAgentTokenUsage extends WorkflowAgentReportedUsage {
  source: WorkflowAgentTokenUsageSource;
  totalTokens: number;
}

export interface WorkflowAgentReportedTelemetry {
  usage?: WorkflowAgentReportedUsage;
  runRef?: string;
  lastActivityAt?: string;
  metadata?: Record<string, unknown>;
}

export type WorkflowAgentTelemetryStatus = "running" | "succeeded" | "failed" | "cached";

export interface WorkflowAgentTelemetry {
  index: number;
  label: string;
  phase?: string;
  model?: string;
  status: WorkflowAgentTelemetryStatus;
  startedAt: string;
  finishedAt?: string;
  lastActivityAt?: string;
  durationMs?: number;
  tokensPerSecond?: number;
  usage?: WorkflowAgentTokenUsage;
  spentTokens?: number;
  runRef?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowAgentRuntimeOptions extends WorkflowAgentOptions {
  index: number;
  phase?: string;
  reportTelemetry?: (telemetry: WorkflowAgentReportedTelemetry) => void;
}

export type WorkflowAgentRunner = (
  prompt: string,
  options: WorkflowAgentRuntimeOptions,
) => Promise<unknown>;

export interface WorkflowRunOptions {
  args?: unknown;
  agent: WorkflowAgentRunner;
  artifactRecord?: WorkflowArtifactRecorder;
  webSearch?: WorkflowWebSearchAdapter;
  fetchContent?: WorkflowFetchContentAdapter;
  concurrency?: number;
  maxAgents?: number;
  /** Hard estimated-token ceiling for this script run. Omit/null for unbounded. */
  tokenBudget?: number | null;
  resumeJournal?: Map<number, WorkflowJournalEntry>;
  /** Private runtime state shared with nested workflow() calls. */
  sharedRuntime?: unknown;
  /** Resolve workflow('name', args) for one-level nested workflow composition. */
  loadWorkflowScript?: (name: string) => string | undefined | Promise<string | undefined>;
  onAgentJournal?: (entry: WorkflowJournalEntry) => void | Promise<void>;
  onPhase?: (phase: WorkflowPhaseRun) => void;
  onLog?: (message: string) => void;
  onTokenUsage?: (usage: {
    spent: number;
    tokens: number;
    index: number;
    phase?: string;
    usage: WorkflowAgentTokenUsage;
  }) => void | Promise<void>;
  now?: () => string;
  onAgentStart?: (event: WorkflowAgentEvent) => void;
  onAgentEnd?: (event: WorkflowAgentEvent & { result: unknown }) => void;
  onAgentTelemetry?: (telemetry: WorkflowAgentTelemetry) => void | Promise<void>;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  phases: WorkflowPhaseRun[];
  agentCount: number;
  journal: WorkflowJournalEntry[];
}
