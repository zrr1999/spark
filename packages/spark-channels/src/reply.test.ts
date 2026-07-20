import { describe, expect, it } from "vitest";
import {
  CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE,
  CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
  ChannelDeliveryError,
  channelDeliveryFailureCertainty,
  channelDeliveryFailureOutcome,
  channelDeliveryNotSent,
  channelDeliveryOutcomeUnknown,
  normalizeChannelDeliveryResult,
  requireChannelDeliveryId,
  type ChannelReplyCapability,
} from "./reply.ts";

describe("channel delivery failure outcomes", () => {
  it("allows fallback only when an adapter explicitly confirms no send occurred", () => {
    const cause = new Error("request rejected before dispatch");
    const error = channelDeliveryNotSent(cause);

    expect(error).toMatchObject({
      code: CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE,
      outcome: "not_sent",
      cause,
    });
    expect(error.message).toContain(cause.message);
    expect(channelDeliveryFailureOutcome(error)).toBe("not_sent");
  });

  it("keeps explicit and untagged ambiguous failures fail-closed", () => {
    const cause = new Error("connection closed after upload");
    const error = channelDeliveryOutcomeUnknown(cause);

    expect(error).toMatchObject({
      code: CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
      outcome: "unknown",
      cause,
    });
    expect(channelDeliveryFailureOutcome(error)).toBe("unknown");
    expect(channelDeliveryFailureOutcome(cause)).toBe("unknown");
    expect(channelDeliveryFailureOutcome("transport failed")).toBe("unknown");
  });

  it("does not trust an outcome field without the matching not-sent code", () => {
    expect(channelDeliveryFailureOutcome({ outcome: "not_sent" })).toBe("unknown");
    expect(
      channelDeliveryFailureOutcome({
        code: CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
        outcome: "not_sent",
      }),
    ).toBe("unknown");
  });

  it("preserves canonical certainty while keeping the legacy outcome API", () => {
    const error = new ChannelDeliveryError("invalid recipient", "not-sent");

    expect(channelDeliveryNotSent(error)).toBe(error);
    expect(channelDeliveryFailureCertainty(error)).toBe("not-sent");
    expect(channelDeliveryFailureOutcome(error)).toBe("not_sent");
  });

  it("allows a pre-dispatch boundary to strengthen an inner unknown error", () => {
    const providerError = new ChannelDeliveryError("transport unavailable", "unknown");
    const error = channelDeliveryNotSent(providerError);

    expect(error).not.toBe(providerError);
    expect(error.cause).toBe(providerError);
    expect(channelDeliveryFailureCertainty(error)).toBe("not-sent");
  });

  it("requires and normalizes durable delivery identities before dispatch", () => {
    expect(requireChannelDeliveryId("  delivery:1  ")).toBe("delivery:1");
    const error = (() => {
      try {
        requireChannelDeliveryId("  ");
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(channelDeliveryFailureCertainty(error)).toBe("not-sent");
  });

  it("normalizes legacy void results without weakening adapter replay facts", () => {
    expect(normalizeChannelDeliveryResult(undefined, { replaySafety: "deduplicated" })).toEqual({
      replaySafety: "deduplicated",
    });
  });

  it("keeps legacy reply capabilities callable without a durable delivery id", async () => {
    const capability: ChannelReplyCapability = {
      openReplyStream: async () => undefined,
      sendReply: async (_target: { recipient: string; text: string }): Promise<void> => undefined,
    };

    await expect(capability.sendReply({ recipient: "user-1", text: "hello" })).resolves.toBe(
      undefined,
    );
  });
});
