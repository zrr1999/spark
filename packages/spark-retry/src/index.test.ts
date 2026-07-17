import { describe, expect, it } from "vitest";
import { cappedExponentialCeiling, equalJitter, scheduledCeiling } from "./index.ts";

describe("cappedExponentialCeiling", () => {
  it("uses one-based exponential ceilings and caps the result", () => {
    expect(cappedExponentialCeiling(-10, 100, 5_000)).toBe(100);
    expect(cappedExponentialCeiling(0, 100, 5_000)).toBe(100);
    expect(cappedExponentialCeiling(1, 100, 5_000)).toBe(100);
    expect(cappedExponentialCeiling(2, 100, 5_000)).toBe(200);
    expect(cappedExponentialCeiling(7, 100, 5_000)).toBe(5_000);
    expect(cappedExponentialCeiling(1_000, 100, 5_000)).toBe(5_000);
  });

  it("supports an independent exponent cap and a zero base", () => {
    expect(cappedExponentialCeiling(100, 100, 60_000, { exponentCap: 3 })).toBe(800);
    expect(cappedExponentialCeiling(1_000, 0, 5_000)).toBe(0);
    expect(cappedExponentialCeiling(2, 100.25, 1_000.75)).toBe(200.5);
  });

  it("rejects invalid timing inputs", () => {
    expect(() => cappedExponentialCeiling(Number.NaN, 100, 5_000)).toThrow(RangeError);
    expect(() =>
      cappedExponentialCeiling(1, 100, 5_000, { exponentCap: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });
});

describe("scheduledCeiling", () => {
  it("selects a one-based schedule entry and retains the last entry", () => {
    const ceilings = [1_000, 2_000, 5_000] as const;
    expect(scheduledCeiling(-10, ceilings)).toBe(1_000);
    expect(scheduledCeiling(0, ceilings)).toBe(1_000);
    expect(scheduledCeiling(1, ceilings)).toBe(1_000);
    expect(scheduledCeiling(2, ceilings)).toBe(2_000);
    expect(scheduledCeiling(10, ceilings)).toBe(5_000);
  });

  it("rejects an empty schedule", () => {
    expect(() => scheduledCeiling(1, [])).toThrow(RangeError);
  });
});

describe("equalJitter", () => {
  it("samples the upper half and clamps the random source", () => {
    expect(equalJitter(1_000, () => -1)).toBe(500);
    expect(equalJitter(1_000, () => 0)).toBe(500);
    expect(equalJitter(1_000, () => 0.5)).toBe(750);
    expect(equalJitter(1_000, () => 1)).toBe(1_000);
    expect(equalJitter(1_000, () => 2)).toBe(1_000);
  });

  it("supports a zero ceiling and rejects a non-finite sample", () => {
    expect(equalJitter(0, () => 0.5)).toBe(0);
    expect(() => equalJitter(100, () => Number.NaN)).toThrow(RangeError);
  });
});
