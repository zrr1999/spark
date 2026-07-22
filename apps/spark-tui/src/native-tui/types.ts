/** Shared types for the Spark native TUI surface. */

import type { CommandMetadata, SparkHostCommandContext } from "@zendev-lab/spark-core";
import type {
  SparkArtifactView,
  SparkEvidenceView,
  SparkInteractionRequest,
  SparkInteractionResponse,
  SparkMessageView,
  SparkRunView,
  SparkSessionView,
  SparkTaskView,
  SparkToolCallView,
} from "@zendev-lab/spark-protocol";
import type { SparkKeybindingContext, SparkKeybindings } from "../host/keybindings.ts";
import type { SparkHostMessageRenderer, RegisteredCommand } from "../host/types.ts";
import type { SparkTheme } from "../host/theme.ts";
import type { SparkNativeSession } from "./session.ts";
import type { SparkNativeTuiApp } from "./app.ts";

export type SparkNativeMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "custom"
  | "tool"
  | "thinking";

/** Canonical Spark tool states. Legacy local callers may still submit success/error. */
export type SparkNativeToolStatus = SparkToolCallView["status"];
export type SparkNativeToolStatusInput = SparkNativeToolStatus | "success" | "error";
export type SparkNativeQueueMode = "steer" | "followUp";

export interface SparkNativeMessage {
  role: SparkNativeMessageRole;
  text: string;
  viewId?: string;
  queued?: boolean;
  streaming?: boolean;
  viewStatus?: SparkMessageView["status"];
  customType?: string;
  display?: boolean;
  details?: Record<string, unknown>;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: SparkNativeToolStatusInput;
  createdAt?: string;
  updatedAt?: string;
  nativeOrder?: number;
}

export interface SparkNativeToolMessageInput {
  toolName: string;
  text: string;
  toolCallId?: string;
  status?: SparkNativeToolStatusInput;
  details?: Record<string, unknown>;
}

export interface SparkNativeCustomMessageInput {
  customType: string;
  content: string;
  display?: boolean;
  details?: Record<string, unknown>;
}

export interface SparkNativeResponderContext {
  readonly messages: readonly SparkNativeMessage[];
  /** Stable identity for one user submit, retained when `/retry` resubmits it. */
  readonly submissionId?: string;
  readonly signal?: AbortSignal;
  readonly appendAssistantChunk?: (chunk: string) => void;
  readonly finishAssistantMessage?: () => void;
}

export type SparkNativeResponder = (
  input: string,
  context: SparkNativeResponderContext,
) => string | Promise<string>;

export interface SparkNativeQueuedInput {
  readonly text: string;
  readonly mode: SparkNativeQueueMode;
  readonly submissionId: string;
}

export interface SparkNativeSubmitOptions {
  mode?: SparkNativeQueueMode;
  submissionId?: string;
}

export interface SparkNativeQueueSummary {
  total: number;
  steer: number;
  followUp: number;
  /** Daemon-admitted turns still queued or running (durable truth). */
  daemonPending: number;
}

export interface SparkNativeAbortResult {
  aborted: boolean;
  clearedQueued: number;
  restoredText?: string;
}

export interface SparkNativeSlashCommandContext {
  readonly app: SparkNativeTuiApp;
  readonly session: SparkNativeSession;
  exit(): void;
}

export interface SparkNativeInteractionContext {
  readonly app: SparkNativeTuiApp;
  readonly session: SparkNativeSession;
}

export type SparkNativeInteractionHandler = (
  request: SparkInteractionRequest,
  context: SparkNativeInteractionContext,
) => SparkInteractionResponse | Promise<SparkInteractionResponse>;

export type SparkNativeSlashCommandHandler = (
  args: string,
  context: SparkNativeSlashCommandContext,
) => string | void | Promise<string | void>;

export interface SparkNativeSlashCommand {
  description: string;
  argumentHint?: string;
  metadata?: CommandMetadata;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) =>
    | Array<{ value: string; label: string; description?: string }>
    | null
    | Promise<Array<{ value: string; label: string; description?: string }> | null>;
  handler: SparkNativeSlashCommandHandler;
}

export type SparkNativeSlashCommandMap = Record<string, SparkNativeSlashCommand>;

export interface SparkNativeRuntimeCommandHost {
  listCommands(): Array<{
    name: string;
    command: Pick<
      RegisteredCommand,
      "description" | "argumentHint" | "metadata" | "getArgumentCompletions" | "handler"
    >;
  }>;
  makeContext(
    extra?: Partial<SparkHostCommandContext> & { setEditorText?: (text: string) => void },
  ): SparkHostCommandContext & { setEditorText?: (text: string) => void };
}

export interface SparkNativeRuntimeSlashCommandOptions {
  exclude?: Iterable<string>;
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (
    content: string,
    context: SparkNativeSlashCommandContext,
  ) => void | Promise<void>;
  setEditorText?: (text: string) => void;
}

export const SPARK_NATIVE_KERNEL_SLASH_COMMANDS = [
  "help",
  "exit",
  "quit",
  "clear",
  "reload",
] as const;

export type SparkNativeCockpitPanel =
  | "overview"
  | "workflows"
  | "runs"
  | "tasks"
  | "artifacts"
  | "reviews"
  | "graft";

export interface SparkNativeWorkflowOption {
  selector: string;
  label: string;
  description?: string;
  source: "interaction" | "run";
}

export interface SparkNativeCockpitState {
  sessionId?: string;
  sessionTitle?: string;
  sessionStatus?: SparkSessionView["status"];
  cwd?: string;
  gitBranch?: string;
  model?: SparkSessionView["model"];
  thinkingLevel?: SparkSessionView["thinkingLevel"];
  selectedWorkflowRunId?: string;
  readonly workflows: Map<string, SparkNativeWorkflowOption>;
  readonly runs: Map<string, SparkRunView>;
  readonly tasks: Map<string, SparkTaskView>;
  readonly artifacts: Map<string, SparkArtifactView>;
  readonly evidence: Map<string, SparkEvidenceView>;
  readonly interactions: Map<string, SparkInteractionRequest>;
}

export interface SparkNativeFooterMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  latestCacheHitPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface SparkNativeCockpitSnapshot {
  activePanel?: SparkNativeCockpitPanel;
  sessionId?: string;
  sessionStatus?: SparkSessionView["status"];
  workflows: number;
  workflowRuns: number;
  roleRuns: number;
  tasks: number;
  artifacts: number;
  evidence: number;
  reviews: number;
  graftItems: number;
  interactions: number;
}

export type SparkNativeWorkspaceSessionMode = "select" | "attached" | "mismatch";

export interface SparkNativeWorkspaceSessionState {
  mode: SparkNativeWorkspaceSessionMode;
  workspaceDir: string;
  workspaceHash: string;
  controlPlaneSessionId?: string;
  attachTarget?: string;
  mismatchDiagnostic?: string;
}

export interface SparkNativeStatusContext {
  activeProvider?: () => string | undefined;
  activeModel?: () => string | undefined;
  thinkingLevel?: () => string | undefined;
  contextWindow?: () => number | undefined;
  autoCompactionEnabled?: () => boolean;
}

export interface SparkNativeTuiAppOptions {
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
  slashCommands?: SparkNativeSlashCommandMap;
  theme?: SparkTheme;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  workspaceSession?: SparkNativeWorkspaceSessionState;
  statusContext?: SparkNativeStatusContext;
}

export interface SparkNativeWidgetComponent {
  render(width?: number): string[];
  invalidate?(): void;
}

export interface SparkNativeWidget {
  key: string;
  placement: "aboveEditor" | "belowEditor";
  lines?: string[];
  component?: SparkNativeWidgetComponent;
}

export const SPARK_COCKPIT_PANELS: readonly SparkNativeCockpitPanel[] = [
  "overview",
  "workflows",
  "runs",
  "tasks",
  "artifacts",
  "reviews",
  "graft",
];

export const MAX_TRANSCRIPT_MESSAGES = 80;
export const MAX_NATIVE_WIDGET_LINES = 12;
export const MAX_COCKPIT_PANEL_ROWS = 6;
export const MAX_NATIVE_QUEUE_ITEMS = 4;
export const SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID = "spark-tui-local-control";
