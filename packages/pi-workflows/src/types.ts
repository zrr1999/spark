export interface WorkflowStage {
  title: string;
  detail?: string;
  model?: string;
}

/** @deprecated Use WorkflowStage. */
export type WorkflowPhase = WorkflowStage;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  stages?: WorkflowStage[];
  /** @deprecated Use stages. */
  phases?: WorkflowStage[];
}

export interface WorkflowJournalEntry {
  index: number;
  hash: string;
  result: unknown;
}

export type WorkflowStageStatus = "success" | "fail" | "skip";
/** @deprecated Use WorkflowStageStatus. */
export type WorkflowPhaseStatus = WorkflowStageStatus;

export interface WorkflowStageOptions {
  status?: WorkflowStageStatus;
  /** Soft token ceiling for work started while this stage is current. */
  budget?: number;
}
/** @deprecated Use WorkflowStageOptions. */
export type WorkflowPhaseOptions = WorkflowStageOptions;

export interface WorkflowStageRun {
  title: string;
  status?: WorkflowStageStatus;
  startedAt: string;
  finishedAt?: string;
}
/** @deprecated Use WorkflowStageRun. */
export type WorkflowPhaseRun = WorkflowStageRun;

export interface WorkflowAgentOptions {
  label?: string;
  stage?: string;
  /** @deprecated Use stage. */
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
  stage?: string;
  /** @deprecated Use stage. */
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
  stage?: string;
  /** @deprecated Use stage. */
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

export type WorkflowRunEventStatus =
  | "queued"
  | "running"
  | "paused"
  | "stopped"
  | "succeeded"
  | "failed"
  | "stale"
  | "skipped"
  | "cached";

export type WorkflowRunNodeKind =
  | "run"
  | "stage"
  | "phase"
  | "parallel_group"
  | "parallel_item"
  | "agent"
  | "tool"
  | "nested_workflow"
  | "artifact";

export type WorkflowRunEventType =
  | "run_started"
  | "run_succeeded"
  | "run_failed"
  | "run_paused"
  | "run_stopped"
  | "run_stale"
  | "stage_started"
  | "stage_finished"
  | "phase_started"
  | "phase_finished"
  | "parallel_group_started"
  | "parallel_group_succeeded"
  | "parallel_group_failed"
  | "parallel_item_started"
  | "parallel_item_succeeded"
  | "parallel_item_failed"
  | "agent_started"
  | "agent_cached"
  | "agent_succeeded"
  | "agent_failed"
  | "tool_started"
  | "tool_succeeded"
  | "tool_failed"
  | "artifact_recorded"
  | "nested_workflow_started"
  | "nested_workflow_succeeded"
  | "nested_workflow_failed"
  | "control_applied"
  | "log";

export interface WorkflowRunEvent {
  id: string;
  sequence: number;
  timestamp: string;
  type: WorkflowRunEventType;
  status?: WorkflowRunEventStatus;
  nodeId?: string;
  parentId?: string;
  nodeKind?: WorkflowRunNodeKind;
  stage?: string;
  /** @deprecated Use stage. */
  phase?: string;
  title?: string;
  label?: string;
  index?: number;
  toolName?: string;
  workflowName?: string;
  meta?: WorkflowMeta;
  stageRun?: WorkflowStageRun;
  /** @deprecated Use stageRun. */
  phaseRun?: WorkflowStageRun;
  telemetry?: WorkflowAgentTelemetry;
  usage?: WorkflowAgentTokenUsage;
  errorMessage?: string;
  message?: string;
  data?: unknown;
  result?: unknown;
}

export interface WorkflowRunNode {
  id: string;
  kind: WorkflowRunNodeKind;
  label: string;
  status: WorkflowRunEventStatus;
  parentId?: string;
  stage?: string;
  /** @deprecated Use stage. */
  phase?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  children: string[];
  errorMessage?: string;
  result?: unknown;
  telemetry?: WorkflowAgentTelemetry;
  usage?: WorkflowAgentTokenUsage;
  data?: unknown;
}

export interface WorkflowRunSnapshot {
  status: WorkflowRunEventStatus;
  runRef?: string;
  meta?: WorkflowMeta;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  nodes: WorkflowRunNode[];
  nodesById: Record<string, WorkflowRunNode>;
  stages: WorkflowRunNode[];
  /** @deprecated Use stages. */
  phases: WorkflowRunNode[];
  eventTail: WorkflowRunEvent[];
  result?: unknown;
  errorMessage?: string;
}

export interface WorkflowAgentRuntimeOptions extends WorkflowAgentOptions {
  index: number;
  stage?: string;
  /** @deprecated Use stage. */
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
  onStage?: (stage: WorkflowStageRun) => void;
  /** @deprecated Use onStage. */
  onPhase?: (stage: WorkflowStageRun) => void;
  onLog?: (message: string) => void;
  onTokenUsage?: (usage: {
    spent: number;
    tokens: number;
    index: number;
    stage?: string;
    /** @deprecated Use stage. */
    phase?: string;
    usage: WorkflowAgentTokenUsage;
  }) => void | Promise<void>;
  now?: () => string;
  onAgentStart?: (event: WorkflowAgentEvent) => void;
  onAgentEnd?: (event: WorkflowAgentEvent & { result: unknown }) => void;
  onAgentTelemetry?: (telemetry: WorkflowAgentTelemetry) => void | Promise<void>;
  onEvent?: (event: WorkflowRunEvent) => void | Promise<void>;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  /** New runtimes populate stages; optional to preserve compatibility with legacy phase-only results. */
  stages?: WorkflowStageRun[];
  /** @deprecated Use stages. */
  phases: WorkflowStageRun[];
  agentCount: number;
  journal: WorkflowJournalEntry[];
}
