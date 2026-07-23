import { describe, expect, it } from "vitest";
import {
  sparkDriverScheduleRequestSchema,
  sparkDriverStartRequestSchema,
  sparkDriverViewSchema,
} from "./driver.ts";

describe("Spark driver protocol", () => {
  it("defaults ordinary drivers to session continuity and accepts fresh explicitly", () => {
    expect(
      sparkDriverStartRequestSchema.parse({
        kind: "loop",
        ownerSessionId: "owner",
        cwd: "/workspace",
        prompt: "tick",
      }),
    ).toMatchObject({ continuity: "session" });
    expect(
      sparkDriverStartRequestSchema.parse({
        kind: "loop",
        ownerSessionId: "owner",
        continuity: "fresh",
        cwd: "/workspace",
        prompt: "tick",
      }),
    ).toMatchObject({ continuity: "fresh" });
  });

  it("keeps generation on the tick-only schedule request, not the public projection", () => {
    expect(
      sparkDriverScheduleRequestSchema.parse({
        driverId: "loop-one",
        generation: 3,
        delayMs: 1_000,
      }),
    ).toEqual({ driverId: "loop-one", generation: 3, delayMs: 1_000 });
    expect(
      sparkDriverViewSchema.parse({
        driverId: "loop-one",
        kind: "loop",
        ownerSessionId: "owner",
        status: "scheduled",
        continuity: "fresh",
        dueAt: "2026-07-23T00:00:00.000Z",
        attempt: 0,
      }),
    ).not.toHaveProperty("generation");
  });
});
