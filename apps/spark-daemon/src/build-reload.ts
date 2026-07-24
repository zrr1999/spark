import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SparkDaemonBuildChange {
  previousFingerprint: string;
  nextFingerprint: string;
}

export function sparkDaemonEntrypointPath(
  argv: readonly string[] = process.argv,
  fallbackUrl = import.meta.url,
): string {
  return realpathSync(sparkDaemonDeploymentEntrypointPath(argv, fallbackUrl));
}

export function sparkDaemonDeploymentEntrypointPath(
  argv: readonly string[] = process.argv,
  fallbackUrl = import.meta.url,
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(env.SPARK_DEPLOYMENT_WATCH_PATH?.trim() || argv[1] || fileURLToPath(fallbackUrl));
}

export function sparkDaemonEntrypointFingerprint(entrypoint = sparkDaemonEntrypointPath()): string {
  const content = readFileSync(entrypoint);
  try {
    const build = JSON.parse(content.toString("utf8")) as { fingerprint?: unknown };
    if (typeof build.fingerprint === "string" && /^sha256:[0-9a-f]{64}$/u.test(build.fingerprint)) {
      return build.fingerprint;
    }
  } catch {
    // Source entrypoints are fingerprinted as bytes below.
  }
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function createSparkDaemonBuildChangeProbe(
  initialFingerprint: string,
  stabilityMs = 2_000,
): {
  observe(fingerprint: string, observedAtMs: number): SparkDaemonBuildChange | undefined;
} {
  let candidateFingerprint: string | undefined;
  let candidateSinceMs = 0;
  const stableForMs = Math.max(0, Math.floor(stabilityMs));
  return {
    observe(fingerprint, observedAtMs) {
      if (fingerprint === initialFingerprint) {
        candidateFingerprint = undefined;
        candidateSinceMs = 0;
        return undefined;
      }
      if (fingerprint !== candidateFingerprint) {
        candidateFingerprint = fingerprint;
        candidateSinceMs = observedAtMs;
        return stableForMs === 0
          ? {
              previousFingerprint: initialFingerprint,
              nextFingerprint: fingerprint,
            }
          : undefined;
      }
      return observedAtMs - candidateSinceMs >= stableForMs
        ? {
            previousFingerprint: initialFingerprint,
            nextFingerprint: fingerprint,
          }
        : undefined;
    },
  };
}

export function watchSparkDaemonBuild(options: {
  entrypoint: string;
  initialFingerprint: string;
  onChange: (change: SparkDaemonBuildChange) => void | Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  stabilityMs?: number;
  fingerprint?: (entrypoint: string) => string;
}): () => void {
  const probe = createSparkDaemonBuildChangeProbe(options.initialFingerprint, options.stabilityMs);
  const fingerprint = options.fingerprint ?? sparkDaemonEntrypointFingerprint;
  let stopped = false;
  let requestingRestart = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
  timer = setInterval(
    () => {
      if (stopped || requestingRestart) return;
      try {
        const change = probe.observe(fingerprint(options.entrypoint), Date.now());
        if (!change) return;
        requestingRestart = true;
        void Promise.resolve(options.onChange(change))
          .then(stop)
          .catch(options.onError ?? (() => {}))
          .finally(() => {
            requestingRestart = false;
          });
      } catch (error) {
        options.onError?.(error);
      }
    },
    Math.max(250, Math.floor(options.intervalMs ?? 1_000)),
  );
  timer.unref();
  return stop;
}
