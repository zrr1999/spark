import type { SparkToolContext } from "./spark-tool-registration.ts";
import type { ForegroundDriverErrorScope } from "./spark-command-types.ts";

export function renderForegroundDriverSafeErrorMessage(scope: ForegroundDriverErrorScope): string {
  return `Spark foreground ${scope} hit an internal error. The raw error was hidden; check debug logs for details.`;
}

export function reportForegroundDriverError(
  ctx: SparkToolContext | undefined,
  scope: ForegroundDriverErrorScope,
  error: unknown,
): void {
  const message = renderForegroundDriverSafeErrorMessage(scope);
  if (ctx?.ui?.notify) ctx.ui.notify(message, "warning");
  else console.warn(message);
  if (shouldLogForegroundDriverDebugErrors()) {
    console.debug(
      `Spark foreground ${scope} internal error: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }`,
    );
  }
}

export function shouldLogForegroundDriverDebugErrors(): boolean {
  return (
    process.env.SPARK_DEBUG_FOREGROUND_DRIVER_ERRORS === "1" || process.env.SPARK_DEBUG === "1"
  );
}

export function compactionAbortSignal(event: unknown): AbortSignal | undefined {
  if (!event || typeof event !== "object") return undefined;
  const signal = (event as { signal?: unknown }).signal;
  if (!signal || typeof signal !== "object") return undefined;
  const candidate = signal as { aborted?: unknown; addEventListener?: unknown };
  if (typeof candidate.aborted !== "boolean") return undefined;
  if (typeof candidate.addEventListener !== "function") return undefined;
  return signal as AbortSignal;
}
