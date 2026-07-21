import type { SubmitFunction } from "@sveltejs/kit";
import type {
  SessionQueueItem,
  SessionQueueLabels,
  SessionStatusBarLabels,
  SlashActionAvailability,
} from "$lib/components/conversation";
import type {
  ConversationPartLabels,
  LoadEarlierOutcome,
} from "$lib/components/conversation/types";
import type { ModelPickerGroup, ModelRuntimeControlLabels } from "$lib/components/model-selector";
import type { PendingWorkbenchAsk } from "$lib/pending-ask";
import type { SessionEventConnectionState } from "$lib/session-event-connection";
import type { SessionTimelineItem } from "$lib/session-timeline";
import type { CockpitSlashCommandSuggestion } from "$lib/slash-actions";
import type { AppMessages } from "$lib/i18n";
import type {
  SparkActionBarView,
  SparkActionView,
  SparkSessionView,
} from "@zendev-lab/spark-protocol";
import type { ChannelSessionPresentation } from "$lib/channel-session-title";
import type {
  ModelControlState,
  SessionRecord,
  SessionsMessages,
  SessionsWorkbenchCopy,
  SubmissionState,
} from "./types";

export type SessionConversationHost = {
  selected: SessionRecord;
  messages: SessionsMessages;
  copy: SessionsWorkbenchCopy;
  canAssign: boolean;
  conversationBusy: boolean;
  activeTurnId: string | null | undefined;
  liveConnection: SessionEventConnectionState;
  connectionLabel: () => string;
  statusLabel: (status: string) => string;
  sessionScopeLabel: (session: SessionRecord) => string;
  sessionPresentation: (session: SessionRecord) => ChannelSessionPresentation;
  timelineFollowKey: string;
  latestAnnouncement: string;
  hasEarlierTimeline: boolean;
  showEarlierTimeline: () => Promise<LoadEarlierOutcome>;
  timelineNavigationItems: Array<{
    id: string;
    actor: "user" | "session";
    label: string;
    summary: string;
    meta: string;
  }>;
  timelineItems: SessionTimelineItem[];
  renderedTimelineItems: SessionTimelineItem[];
  activeProcessItemId: string | null;
  conversationPartLabels: ConversationPartLabels;
  relative: (value: string | null) => string;
  retryableTimelineItemId: string | null;
  latestRetryPrompt: string | null;
  retryState: SubmissionState;
  modelReady: boolean;
  retryConversationTurn: (prompt: string) => void;
  get sessionModelForm(): HTMLFormElement | null;
  set sessionModelForm(value: HTMLFormElement | null);
  get sessionThinkingForm(): HTMLFormElement | null;
  set sessionThinkingForm(value: HTMLFormElement | null);
  get retryMessageForm(): HTMLFormElement | null;
  set retryMessageForm(value: HTMLFormElement | null);
  get sessionModel(): string;
  set sessionModel(value: string);
  get sessionThinkingLevel(): string;
  set sessionThinkingLevel(value: string);
  retryPrompt: string;
  retrySubmissionId: string;
  get message(): string;
  set message(value: string);
  sendSubmissionId: string;
  sendState: SubmissionState;
  sendFeedback: string | null;
  retryFeedback: string | null;
  modelFeedback: string | null;
  thinkingFeedback: string | null;
  cancelFeedback: string | null;
  dequeueFeedback: string | null;
  modelState: SubmissionState;
  thinkingState: SubmissionState;
  cancelState: SubmissionState;
  dequeueState: SubmissionState;
  dequeuingTurnId: string | null;
  queueItems: SessionQueueItem[];
  queueLabels: SessionQueueLabels;
  queueRemoveFormId: (id: string) => string;
  sessionPendingAsk: PendingWorkbenchAsk | null;
  askDetailMessages: AppMessages["inboxDetail"] | null;
  liveSessionView: SparkSessionView | null;
  statusBarLabels: SessionStatusBarLabels;
  compactWorkingDirectory: (value: string | undefined) => string;
  runtimeStatusUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    latestCacheHitPercent?: number;
    contextTokens?: number;
    contextWindow?: number;
  };
  modelProvidersLength: number;
  modelGroups: ModelPickerGroup[];
  modelRuntimeLabels: ModelRuntimeControlLabels;
  availableModelsLength: number;
  modelControl: ModelControlState;
  effectiveModelAvailable: boolean;
  get sessionModelPickerOpen(): boolean;
  set sessionModelPickerOpen(value: boolean);
  sessionSlashSuggestions: readonly CockpitSlashCommandSuggestion[];
  sessionSlashActionBar: SparkActionBarView | undefined;
  sessionSlashActiveIndex: number;
  setSessionSlashActiveIndex: (index: number) => void;
  sessionSlashListboxId: string;
  sessionSlashActiveOptionId: string | undefined;
  enhanceCancelTurn: SubmitFunction;
  enhanceSelectModel: SubmitFunction;
  enhanceSelectThinking: SubmitFunction;
  enhanceRemoveQueuedTurn: SubmitFunction;
  enhanceRetryMessage: SubmitFunction;
  enhanceSendMessage: SubmitFunction;
  slashActionAvailability: (action: SparkActionView, surface: "session") => SlashActionAvailability;
  handleSessionMessageChange: (value: string) => void;
  handleSlashCompletionKeydown: (event: KeyboardEvent, surface: "session") => void;
  selectSlashSuggestion: (
    suggestion: Readonly<{ id: string; command: string; title: string; description?: string }>,
    surface: "session",
  ) => void;
  handleSlashAction: (action: SparkActionView, surface: "session") => void | Promise<void>;
  submitModelSelection: (value: string) => void | Promise<void>;
  submitThinkingSelection: () => void | Promise<void>;
};
