import { equalJitter, scheduledCeiling } from "@zendev-lab/spark-retry";

/**
 * Equal-jitter retry delay. The supplied delay is the exponential-backoff
 * ceiling; each attempt waits between 50% and 100% of it so multiple daemon
 * instances do not reconnect in lockstep.
 */
export function reconnectDelayWithJitter(
  ceilingMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.max(1, Math.floor(ceilingMs));
  return Math.max(1, equalJitter(ceiling, random));
}

/** Select a one-based reconnect schedule entry and apply equal jitter. */
export function scheduledReconnectDelayWithJitter(
  attempt: number,
  ceilings: readonly number[],
  random: () => number = Math.random,
): number {
  return reconnectDelayWithJitter(scheduledCeiling(attempt, ceilings), random);
}
