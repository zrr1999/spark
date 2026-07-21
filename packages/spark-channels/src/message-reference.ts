/** How inbound quote/reference preview was obtained. */
export type ChannelMessageReferenceSource = "embedded" | "session" | "fetched" | "unknown";

/**
 * Display-safe inbound quote/reference. Never carries raw platform blobs.
 * `IncomingMessage.text` remains the user's own reply body.
 */
export interface ChannelMessageReference {
  /** Platform id of the referenced message, when known. */
  messageId?: string;
  /** Secondary platform id (for example Infoflow msgid2) when required. */
  secondaryMessageId?: string;
  /** Best-effort preview already present on the event or later enrichment. */
  preview?: string;
  senderId?: string;
  senderName?: string;
  source: ChannelMessageReferenceSource;
}

/** Normalize a partial quote/reference into a durable inbound shape. */
export function normalizeChannelMessageReference(
  value: unknown,
): ChannelMessageReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const messageId = nonEmptyString(record.messageId);
  const secondaryMessageId = nonEmptyString(record.secondaryMessageId);
  const preview = nonEmptyString(record.preview)?.slice(0, 16_000);
  const senderId = nonEmptyString(record.senderId);
  const senderName = nonEmptyString(record.senderName);
  const source = normalizeSource(record.source);
  if (!messageId && !secondaryMessageId && !preview && !senderId && !senderName) {
    return undefined;
  }
  return {
    ...(messageId ? { messageId } : {}),
    ...(secondaryMessageId ? { secondaryMessageId } : {}),
    ...(preview ? { preview } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    source: source ?? (preview ? "embedded" : "unknown"),
  };
}

export function mergeChannelMessageReference(
  base: ChannelMessageReference | undefined,
  patch: ChannelMessageReference | undefined,
): ChannelMessageReference | undefined {
  if (!base) return patch;
  if (!patch) return base;
  return normalizeChannelMessageReference({
    messageId: patch.messageId ?? base.messageId,
    secondaryMessageId: patch.secondaryMessageId ?? base.secondaryMessageId,
    preview: patch.preview ?? base.preview,
    senderId: patch.senderId ?? base.senderId,
    senderName: patch.senderName ?? base.senderName,
    source:
      patch.preview && !base.preview ? patch.source : base.preview ? base.source : patch.source,
  });
}

function normalizeSource(value: unknown): ChannelMessageReferenceSource | undefined {
  return value === "embedded" || value === "session" || value === "fetched" || value === "unknown"
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
