import { describe, expect, it } from "vitest";
import {
  sparkInvocationEventSchema,
  sparkTurnCancelRequestSchema,
  sparkTurnAttachmentsSchema,
  sparkTurnSubmitRequestSchema,
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

  it("accepts valid provider/model in submit request schema", () => {
    const valid = sparkTurnSubmitRequestSchema.parse({
      sessionId: "sess-1",
      prompt: "hello",
      model: "anthropic/claude-sonnet-4-20250514",
    });
    expect(valid.model).toBe("anthropic/claude-sonnet-4-20250514");

    // Without model — should be undefined
    const noModel = sparkTurnSubmitRequestSchema.parse({
      sessionId: "sess-1",
      prompt: "hello",
    });
    expect(noModel.model).toBeUndefined();

    // Invalid model formats
    expect(() =>
      sparkTurnSubmitRequestSchema.parse({
        sessionId: "sess-1",
        prompt: "hello",
        model: "no-slash",
      }),
    ).toThrow();
    expect(() =>
      sparkTurnSubmitRequestSchema.parse({
        sessionId: "sess-1",
        prompt: "hello",
        model: "/leading-slash",
      }),
    ).toThrow();
    expect(() =>
      sparkTurnSubmitRequestSchema.parse({
        sessionId: "sess-1",
        prompt: "hello",
        model: "has space/model",
      }),
    ).toThrow();
  });

  it("accepts bounded canonical image and file attachments", () => {
    const data = Buffer.from("hello").toString("base64");
    const attachments = sparkTurnAttachmentsSchema.parse([
      {
        kind: "image",
        name: "shot.png",
        mediaType: "image/png",
        size: 5,
        data,
      },
      {
        kind: "file",
        name: "notes.txt",
        mediaType: "text/plain",
        size: 5,
        data,
      },
    ]);

    expect(attachments.map((attachment) => attachment.name)).toEqual(["shot.png", "notes.txt"]);
    expect(() =>
      sparkTurnAttachmentsSchema.parse([
        {
          kind: "image",
          name: "broken.png",
          mediaType: "image/png",
          size: 4,
          data,
        },
      ]),
    ).toThrow(/canonical base64 matching size/u);
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
