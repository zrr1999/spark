import { describe, expect, it } from "vitest";
import {
  sparkInvocationEventSchema,
  sparkTurnCancelRequestSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnSubmitResultSchema,
} from "./invocation-lifecycle.ts";

describe("invocation lifecycle protocol", () => {
  it("parses bounded submit/status/stream/cancel payloads without queue identity", () => {
    const acceptedAt = "2026-07-14T00:00:00.000Z";
    const submit = sparkTurnSubmitResultSchema.parse({
      invocationId: "inv_0123456789",
      status: "queued",
      acceptedAt,
    });
    const status = sparkTurnStatusResultSchema.parse({
      invocationId: submit.invocationId,
      status: "running",
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      eventCursor: 3,
    });
    const page = sparkTurnStreamPageSchema.parse({
      invocationId: submit.invocationId,
      events: [
        {
          invocationId: submit.invocationId,
          sequence: 1,
          kind: "text.delta",
          payload: { text: "hello" },
          createdAt: acceptedAt,
        },
      ],
      nextCursor: 1,
      hasMore: false,
    });
    const cancel = sparkTurnCancelRequestSchema.parse({
      invocationId: submit.invocationId,
      reason: "user requested",
    });

    expect({ submit, status, page, cancel }).not.toHaveProperty("fileName");
    expect(JSON.stringify({ submit, status, page, cancel })).not.toMatch(
      /filePath|inbox|processed|failed|queueState/u,
    );
  });

  it("rejects queue-shaped ids and oversized event pages", () => {
    expect(() =>
      sparkTurnSubmitResultSchema.parse({
        invocationId: "turn-file.json",
        status: "queued",
        acceptedAt: "2026-07-14T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      sparkTurnStreamPageSchema.parse({
        invocationId: "inv_0123456789",
        events: Array.from({ length: 501 }, (_, index) => ({
          invocationId: "inv_0123456789",
          sequence: index + 1,
          kind: "delta",
          payload: {},
          createdAt: "2026-07-14T00:00:00.000Z",
        })),
        nextCursor: 501,
        hasMore: false,
      }),
    ).toThrow();
    expect(sparkInvocationEventSchema.shape.payload).toBeDefined();
  });
});
