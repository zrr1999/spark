import { describe, expect, it } from "vitest";
import { reconnectDelayWithJitter } from "./reconnect-delay.ts";

describe("reconnectDelayWithJitter", () => {
  it("uses injectable equal jitter and clamps the sample", () => {
    expect(reconnectDelayWithJitter(1_000, () => 0)).toBe(500);
    expect(reconnectDelayWithJitter(1_000, () => 0.5)).toBe(750);
    expect(reconnectDelayWithJitter(1_000, () => 1)).toBe(1_000);
    expect(reconnectDelayWithJitter(1_000, () => 2)).toBe(1_000);
  });
});
