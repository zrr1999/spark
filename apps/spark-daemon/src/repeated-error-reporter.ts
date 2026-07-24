export interface RepeatedErrorReporter {
  report(error: unknown): void;
  recovered(): void;
  flush(): void;
}

export interface RepeatedErrorReporterOptions {
  intervalMs?: number;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Report the first failure immediately, then emit at most one full failure per
 * interval for the same error fingerprint. Recovery and shutdown flush a
 * bounded suppression summary instead of replaying every identical stack.
 */
export function createRepeatedErrorReporter(
  label: string,
  options: RepeatedErrorReporterOptions = {},
): RepeatedErrorReporter {
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? 60_000));
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((message, error) => {
      if (error === undefined) console.error(message);
      else console.error(message, error);
    });
  let active:
    | {
        fingerprint: string;
        lastReportedAt: number;
        suppressed: number;
      }
    | undefined;

  const flushSummary = (suffix: string) => {
    if (!active || active.suppressed === 0) return;
    log(`${label}; suppressed ${active.suppressed} repeated failures${suffix}`);
    active.suppressed = 0;
  };

  return {
    report(error) {
      const observedAt = now();
      const fingerprint = errorFingerprint(error);
      if (!active || active.fingerprint !== fingerprint) {
        flushSummary(" before the failure changed");
        log(label, error);
        active = { fingerprint, lastReportedAt: observedAt, suppressed: 0 };
        return;
      }
      if (observedAt - active.lastReportedAt >= intervalMs) {
        flushSummary(" during the previous interval");
        log(label, error);
        active.lastReportedAt = observedAt;
        return;
      }
      active.suppressed += 1;
    },
    recovered() {
      if (!active) return;
      flushSummary(" before recovery");
      active = undefined;
    },
    flush() {
      flushSummary(" before shutdown");
      active = undefined;
    },
  };
}

function errorFingerprint(error: unknown): string {
  if (error instanceof Error) return `${error.name}\u0000${error.message}`;
  return `${typeof error}\u0000${String(error)}`;
}
