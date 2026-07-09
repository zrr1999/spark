/**
 * Internal types backing the spark-tui native ExtensionAPI host.
 *
 * Public-facing extension contracts come from `spark-extension-api`. The shapes
 * declared here are private to the host runtime: they describe how registered
 * tools, commands, event listeners, and host-side message envelopes are kept
 * inside SparkHostRuntime. Extension authors should not import from this file.
 */

import type {
  CommandMetadata,
  ExtensionContext,
  ExtensionUi,
  ToolConfig,
  ToolInfo,
} from "@zendev-lab/spark-extension-api";
import type { SparkDaemonEvent, SparkViewModelEvent } from "@zendev-lab/spark-protocol";

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
    ctx: ExtensionContext & {
      waitForIdle?: () => Promise<void>;
      sendUserMessage?: (content: string) => Promise<void>;
    },
  ) => void | Promise<void>;
}

export type BuiltinEventName =
  | "session_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "user_message"
  | "assistant_message";

export type EventName = BuiltinEventName | (string & {});

export type EventListener = (event: unknown, ctx: ExtensionContext) => unknown;

/**
 * Outbox slot for `pi.sendMessage(...)` and `pi.sendUserMessage(...)`. The
 * host pulls drained envelopes when the agent loop is ready to consume them.
 */
export interface OutboxEnvelope {
  kind: "custom" | "user";
  customType?: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  display?: boolean;
  details?: Record<string, unknown>;
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
export type EventListenerMap = Map<EventName, EventListener[]>;

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
