import { describe, expect, it } from "vitest";
import {
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadSnapshotSchema,
  sparkSideThreadSubmitRequestSchema,
} from "./side-thread.ts";

describe("side-thread protocol", () => {
  it("parses a daemon-owned snapshot", () => {
    expect(
      sparkSideThreadSnapshotSchema.parse({
        parentSessionId: "sess_parent",
        sessionId: "sess_side",
        generation: 2,
        mode: "contextual",
        status: "idle",
      }),
    ).toEqual({
      parentSessionId: "sess_parent",
      sessionId: "sess_side",
      generation: 2,
      mode: "contextual",
      status: "idle",
      pendingTurns: [],
      exchanges: [],
      hasMore: false,
      projectionTruncated: false,
    });
  });

  it("requires optimistic concurrency and idempotency for mutations", () => {
    expect(() =>
      sparkSideThreadSubmitRequestSchema.parse({
        parentSessionId: "sess_parent",
        prompt: "inspect this",
      }),
    ).toThrow();

    expect(
      sparkSideThreadHandoffRequestSchema.parse({
        parentSessionId: "sess_parent",
        expectedGeneration: 1,
        expectedHeadExchangeId: "exchange_1",
        kind: "full",
        idempotencyKey: "handoff_1",
      }),
    ).toMatchObject({ kind: "full", expectedGeneration: 1 });
  });

  it("rejects empty configuration updates", () => {
    expect(() =>
      sparkSideThreadConfigureRequestSchema.parse({
        parentSessionId: "sess_parent",
        expectedGeneration: 1,
      }),
    ).toThrow(/configure requires/u);
  });
});
