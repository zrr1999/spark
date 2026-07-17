/** Options for a capped exponential timing ceiling. */
export interface CappedExponentialCeilingOptions {
  /** Optional cap for the exponent, independent from the millisecond cap. */
  exponentCap?: number;
}

/**
 * Compute a capped exponential ceiling for a one-based attempt number.
 * Attempts below one use the first ceiling; fractional values are floored.
 */
export function cappedExponentialCeiling(
  attempt: number,
  baseMs: number,
  maxMs: number,
  options: CappedExponentialCeilingOptions = {},
): number {
  const normalizedAttempt = attemptInteger(attempt);
  const normalizedBase = nonNegativeNumber(baseMs, "baseMs");
  const normalizedMax = nonNegativeNumber(maxMs, "maxMs");
  const uncappedExponent = Math.max(0, normalizedAttempt - 1);
  const exponent =
    options.exponentCap === undefined
      ? uncappedExponent
      : Math.min(uncappedExponent, nonNegativeInteger(options.exponentCap, "options.exponentCap"));

  if (normalizedBase === 0) return 0;
  return Math.min(normalizedMax, normalizedBase * 2 ** exponent);
}

/**
 * Select a ceiling from a one-based schedule, retaining the final entry after
 * the schedule is exhausted.
 */
export function scheduledCeiling(attempt: number, ceilings: readonly number[]): number {
  if (ceilings.length === 0) {
    throw new RangeError("ceilings must contain at least one value");
  }
  const normalizedAttempt = attemptInteger(attempt);
  const index = Math.min(Math.max(0, normalizedAttempt - 1), ceilings.length - 1);
  return nonNegativeNumber(ceilings[index]!, `ceilings[${index}]`);
}

/**
 * Sample equal jitter in the inclusive upper half of a timing ceiling.
 * The random sample is clamped so injected deterministic sources remain safe.
 */
export function equalJitter(ceilingMs: number, random: () => number = Math.random): number {
  const ceiling = nonNegativeInteger(ceilingMs, "ceilingMs");
  const sample = random();
  if (!Number.isFinite(sample)) {
    throw new RangeError("random() must return a finite number");
  }
  const clampedSample = Math.max(0, Math.min(1, sample));
  return Math.floor(ceiling * (0.5 + clampedSample * 0.5));
}

function nonNegativeInteger(value: number, name: string): number {
  return Math.floor(nonNegativeNumber(value, name));
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function attemptInteger(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("attempt must be a finite number");
  }
  return Math.max(0, Math.floor(value));
}
