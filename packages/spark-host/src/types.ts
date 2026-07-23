/**
 * Internal types backing the spark-tui native SparkHostAPI host.
 *
 * Public-facing extension contracts come from `spark-core`. The shapes
 * declared here are private to the host runtime: they describe how registered
 * tools, commands, event listeners, and host-side message envelopes are kept
 * inside SparkHostRuntime. Extension authors should not import from this file.
 */

import type {
  CommandMetadata,
  SparkHostContext,
  ToolEffect,
  SparkHostRuntimeMessageAuthority,
  SparkHostRuntimeMessageTrust,
  ExtensionUi,
  ResolvedToolPolicy,
  ToolConfig,
  ToolInfo,
} from "@zendev-lab/spark-core";
import type {
  SparkDaemonEvent,
  SparkHostBuiltinEventName,
  SparkHostBuiltinEventPayloadMap,
  SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";
import { SPARK_HOST_BUILTIN_EVENT_NAMES } from "@zendev-lab/spark-protocol";

export interface SparkHostRegistryModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

export interface SparkHostModelRegistryLike {
  getAvailable(): SparkHostRegistryModel[] | Promise<SparkHostRegistryModel[]>;
  getAll(): SparkHostRegistryModel[];
  hasConfiguredAuth(model: SparkHostRegistryModel): boolean;
  getError?(): string | undefined;
}

export interface RegisteredTool {
  config: ToolConfig;
  /** Immutable policy snapshot resolved when the tool was registered. */
  policy: ResolvedToolPolicy;
  active: boolean;
}

export interface RegisteredCommand {
  description: string;
  argumentHint?: string;
  metadata?: CommandMetadata;
  getArgumentCompletions?: (
    prefix: string,
  ) =>
    | Array<{ value: string; label: string; description?: string }>
    | null
    | Promise<Array<{ value: string; label: string; description?: string }> | null>;
  handler: (
    args: string,
    ctx: SparkHostContext & {
      waitForIdle?: () => Promise<void>;
      sendUserMessage?: (content: string) => Promise<void>;
    },
  ) => void | Promise<void>;
}

/** @deprecated Prefer `SparkHostBuiltinEventName` from spark-protocol. */
export type BuiltinEventName = SparkHostBuiltinEventName;

export const BUILTIN_EVENT_NAMES = SPARK_HOST_BUILTIN_EVENT_NAMES;

export type EventName = SparkHostBuiltinEventName | (string & {});

export type BuiltinEventPayloadMap = SparkHostBuiltinEventPayloadMap;

export type EventListener<E extends EventName = EventName> = E extends SparkHostBuiltinEventName
  ? (event: BuiltinEventPayloadMap[E], ctx: SparkHostContext) => unknown
  : (event: unknown, ctx: SparkHostContext) => unknown;

/** Stored listener metadata (payload erased) for the runtime registry map. */
export interface RegisteredEventListener {
  handler: (event: unknown, ctx: SparkHostContext) => unknown;
  /** Undefined means unknown, never implicit read-only. */
  effects: readonly ToolEffect[] | undefined;
}

/**
 * Outbox slot for `pi.sendMessage(...)` and `pi.sendUserMessage(...)`. The
 * host pulls drained envelopes when the agent loop is ready to consume them.
 */
export interface OutboxEnvelope {
  kind: "custom" | "user";
  /** Session active when the message was enqueued; prevents cross-session drain. */
  sessionId?: string;
  customType?: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  display?: boolean;
  details?: Record<string, unknown>;
  authority?: SparkHostRuntimeMessageAuthority;
  trust?: SparkHostRuntimeMessageTrust;
  options: {
    deliverAs?: "steer" | "followUp" | "nextTurn";
    streamingBehavior?: "steer" | "followUp";
    triggerTurn?: boolean;
  };
  enqueuedAt: number;
}

/**
 * UI bridge plugged into the SparkHostRuntime by the surrounding TUI shell.
 * In the spark-tui native host the implementation forwards calls onto the
 * pi-tui application; in tests a stub returning undefined is enough to keep
 * extensions running without crashes (every call site uses optional chaining).
 */
export interface SparkHostCustomMessage {
  customType: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  display?: boolean;
  details?: Record<string, unknown>;
  authority?: SparkHostRuntimeMessageAuthority;
  trust?: SparkHostRuntimeMessageTrust;
}

export interface SparkHostUiTransport extends ExtensionUi {
  setEditorText?: (text: string) => void;
  customMessage?: (message: SparkHostCustomMessage) => void;
  publishView?: (event: SparkViewModelEvent) => void;
}

export interface SparkHostSessionManagerStub {
  getSessionFile?: () => string | undefined;
  getLeafId?: () => string | undefined;
  getEntries?: () => unknown[];
  getBranch?: () => unknown[];
  getLabel?: (entryId: string) => string | undefined;
}

export type RegisteredToolMap = Map<string, RegisteredTool>;
export type RegisteredCommandMap = Map<string, RegisteredCommand>;
export type EventListenerMap = Map<EventName, RegisteredEventListener[]>;

export type ToolRegistrationListener = (info: ToolInfo) => void;
export type SparkDaemonEventListener = (event: SparkDaemonEvent) => void;

export interface SparkHostMessageRenderOptions {
  expanded: boolean;
}

export interface SparkHostRenderTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough?(text: string): string;
}

export interface SparkHostRenderComponent {
  render(width: number): string[];
  invalidate?(): void;
}

export type SparkHostMessageRenderer<T = unknown> = (
  message: SparkHostCustomMessage & {
    details?: T extends Record<string, unknown> ? T : Record<string, unknown>;
  },
  options: SparkHostMessageRenderOptions,
  theme: SparkHostRenderTheme,
) => SparkHostRenderComponent | undefined;
