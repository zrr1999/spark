/** Platform-neutral destination and provenance for one channel reply. */
export interface ChannelReplyTarget {
  recipient: string;
  /** Original sender id; adapters may use it for a group mention. */
  senderId?: string;
  /** Original platform message id; adapters must not guess missing quote metadata. */
  messageId?: string;
  /** Display-safe source preview for adapters that can quote a message. */
  preview?: string;
}

/** Streaming reply lifecycle shared by daemon and channel adapters. */
export interface ChannelReplyStream {
  appendText(delta: string): void;
  /** Optional reasoning / thinking stream (Infoflow thinking_aio). */
  appendReasoning?(delta: string): void;
  notifyToolStart(input: { name?: string; phase?: string }): void;
  notifyToolResult(text: string): void;
  complete(label?: string): Promise<void>;
  fail(message: string): Promise<void>;
}

/** Optional adapter capability; ordinary notify remains a simple text API. */
export interface ChannelReplyCapability {
  openReplyStream(target: ChannelReplyTarget): Promise<ChannelReplyStream | undefined>;
  sendReply(target: ChannelReplyTarget & { text: string }): Promise<void>;
}
