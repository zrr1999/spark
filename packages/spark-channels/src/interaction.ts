import type { SparkChannelAdapter } from "@zendev-lab/spark-protocol/session-assignment";

/** One selectable action rendered by a channel-native ask surface. */
export interface ChannelAskOption {
  /** Stable within this ask; adapters may use it as a native button id. */
  id?: string;
  label: string;
  /** Opaque correlation data returned verbatim when the option is selected. */
  data: string;
}

export type ChannelAskAudience =
  | { kind: "everyone" }
  | { kind: "admins" }
  | { kind: "users"; userIds: readonly string[] };

/** Platform-neutral input for a channel-native single-step ask. */
export interface ChannelAskRequest {
  /** Prompt body. Adapters may render supported Markdown syntax. */
  prompt: string;
  options: readonly ChannelAskOption[];
  /** Who may operate the native controls. Default: everyone. */
  audience?: ChannelAskAudience;
  /** Original platform message id when the ask is a passive reply. */
  messageId?: string;
  /** Fallback shown by clients that cannot render the native control. */
  unsupportedText?: string;
}

export interface ChannelAskSendResult {
  messageId?: string;
}

export type ChannelInteractionScene = "c2c" | "group" | "channel";

/** A native interaction, kept separate from ordinary text ingress. */
export interface ChannelInteractionEvent {
  adapter: SparkChannelAdapter;
  interactionId: string;
  actorId: string;
  scene: ChannelInteractionScene;
  /** Canonical adapter recipient encoding for follow-up messages, when supplied by the event. */
  recipient?: string;
  /** Opaque data supplied by the corresponding ChannelAskOption. */
  buttonData: string;
  buttonId?: string;
  messageId?: string;
  raw?: unknown;
}

/** Interaction after a concrete configured adapter has been identified. */
export interface RoutedChannelInteractionEvent extends ChannelInteractionEvent {
  adapterId: string;
}

export type ChannelInteractionAckStatus =
  | "success"
  | "failed"
  | "rate_limited"
  | "duplicate"
  | "forbidden"
  | "admins_only";

/** Optional adapter capability for native ask controls and their acknowledgements. */
export interface ChannelInteractionCapability {
  sendAsk(recipient: string, request: ChannelAskRequest): Promise<ChannelAskSendResult>;
  ackInteraction(interactionId: string, status?: ChannelInteractionAckStatus): Promise<void>;
}
