export interface ConversationScrollTarget {
  scrollTop: number;
  readonly scrollHeight: number;
}

export interface ConversationPrependAnchor {
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

/** Capture the viewport geometry before older messages are prepended. */
export function captureConversationPrependAnchor(
  target: ConversationScrollTarget,
): ConversationPrependAnchor {
  return {
    scrollTop: target.scrollTop,
    scrollHeight: target.scrollHeight,
  };
}

/** Keep the first visible message stationary after content is prepended above it. */
export function restoreConversationPrependAnchor(
  target: ConversationScrollTarget,
  anchor: ConversationPrependAnchor,
) {
  const nextScrollTop = Math.max(0, anchor.scrollTop + (target.scrollHeight - anchor.scrollHeight));
  target.scrollTop = nextScrollTop;
  return nextScrollTop;
}
