import type { Snippet } from "svelte";
import type { SparkActionBarView, SparkActionView } from "@zendev-lab/spark-protocol";

export type SlashActionAvailability = Readonly<{
  enabled: boolean;
  reason?: string;
}>;

export type SlashActionBarProps = {
  view: SparkActionBarView;
  disabled?: boolean;
  disabledReason?: string;
  resolveAction?: (action: SparkActionView) => SlashActionAvailability;
  onAction?: (action: SparkActionView) => void | Promise<void>;
};

export type SessionQueueItem = Readonly<{
  id: string;
  text: string;
  description?: string;
}>;

export type SessionQueueLabels = Readonly<{
  region: string;
  queued: string;
  next: string;
}>;

export type SessionQueueProps = {
  items: readonly SessionQueueItem[];
  labels: SessionQueueLabels;
  hasRunningTurn: boolean;
  defaultOpen?: boolean;
  actions?: Snippet<[SessionQueueItem]>;
};

export { default as ApprovalPart } from "./ApprovalPart.svelte";
export { default as ArtifactPart } from "./ArtifactPart.svelte";
export { default as Composer } from "./Composer.svelte";
export { default as ConversationViewport } from "./ConversationViewport.svelte";
export { default as ErrorPart } from "./ErrorPart.svelte";
export { default as Message } from "./Message.svelte";
export { default as MessageActions } from "./MessageActions.svelte";
export { default as ReasoningPart } from "./ReasoningPart.svelte";
export { default as SessionQueue } from "./SessionQueue.svelte";
export { default as SessionRetryAction } from "./SessionRetryAction.svelte";
export { default as SessionStatusBar } from "./SessionStatusBar.svelte";
export { default as SlashActionBar } from "./SlashActionBar.svelte";
export { default as SlashCommandMenu } from "./SlashCommandMenu.svelte";
export type { SlashCommandSuggestion } from "./slash-command";
export { default as TaskRunPart } from "./TaskRunPart.svelte";
export { default as ToolCallPart } from "./ToolCallPart.svelte";
export {
  conversationPartsFromMessage,
  conversationPartText,
  groupThinkingChainParts,
  preferToolSummary,
  textConversationPart,
  visibleConversationParts,
  visibleConversationPartText,
} from "./conversation-view";
export type {
  ConversationApprovalState,
  ConversationChainStep,
  ConversationMessageView,
  ConversationPart,
  ConversationPartLabels,
  ConversationTaskState,
  ConversationToolState,
} from "./types";
export { default as ThinkingChainPart } from "./ThinkingChainPart.svelte";
export {
  sessionAutoCompactionEnabled,
  sessionStatusIdentity,
  sessionStatusUsage,
} from "./session-status";
export type {
  SessionStatusBarLabels,
  SessionStatusIdentityInput,
  SessionStatusSnapshot,
  SessionStatusUsage,
} from "./session-status";
