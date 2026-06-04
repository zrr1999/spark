/** Signal helper for graceful Spark daemon shutdown. */

export interface SparkDaemonSignals {
  readonly stopped: boolean;
  stop(): void;
  dispose(): void;
}

export function createSparkDaemonSignals(
  signalNames: NodeJS.Signals[] = ["SIGINT", "SIGTERM"],
): SparkDaemonSignals {
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  for (const signal of signalNames) process.once(signal, onSignal);
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
    },
    dispose() {
      for (const signal of signalNames) process.off(signal, onSignal);
    },
  };
}
