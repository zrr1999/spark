import { describe, expect, it } from "vitest";
import { reconnectDelayWithJitter, scheduledReconnectDelayWithJitter } from "./reconnect-delay.ts";

describe("reconnectDelayWithJitter", () => {
  it("uses injectable equal jitter and clamps the sample", () => {
    expect(reconnectDelayWithJitter(1_000, () => 0)).toBe(500);
    expect(reconnectDelayWithJitter(1_000, () => 0.5)).toBe(750);
    expect(reconnectDelayWithJitter(1_000, () => 1)).toBe(1_000);
    expect(reconnectDelayWithJitter(1_000, () => 2)).toBe(1_000);
  });
});

describe("scheduledReconnectDelayWithJitter", () => {
  it("selects a one-based ceiling and retains the last schedule entry", () => {
    const ceilings = [1_000, 2_000, 5_000] as const;
    expect(scheduledReconnectDelayWithJitter(1, ceilings, () => 1)).toBe(1_000);
    expect(scheduledReconnectDelayWithJitter(2, ceilings, () => 1)).toBe(2_000);
    expect(scheduledReconnectDelayWithJitter(10, ceilings, () => 1)).toBe(5_000);
  });
});
