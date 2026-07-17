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
  const sample = Math.max(0, Math.min(1, random()));
  return Math.max(1, Math.floor(ceiling * (0.5 + sample * 0.5)));
}
