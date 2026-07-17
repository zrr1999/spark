import { describe, expect, it } from "vitest";

import {
  captureConversationPrependAnchor,
  restoreConversationPrependAnchor,
} from "./conversation-scroll-anchor";

describe("conversation prepend scroll anchor", () => {
  it("preserves the visible content offset when older messages are prepended", () => {
    const viewport = { scrollTop: 42, scrollHeight: 800 };
    const anchor = captureConversationPrependAnchor(viewport);

    viewport.scrollHeight = 1_160;

    expect(restoreConversationPrependAnchor(viewport, anchor)).toBe(402);
    expect(viewport.scrollTop).toBe(402);
  });

  it("never restores a negative scroll position", () => {
    const viewport = { scrollTop: 8, scrollHeight: 800 };
    const anchor = captureConversationPrependAnchor(viewport);

    viewport.scrollHeight = 700;

    expect(restoreConversationPrependAnchor(viewport, anchor)).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });
});
