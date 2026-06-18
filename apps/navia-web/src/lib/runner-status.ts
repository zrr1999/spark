export type RunnerConnectionStatus = "online" | "offline" | "draining" | "disabled";
export type RunnerDisplayStatus = RunnerConnectionStatus | "registered";

export interface RunnerConnectionStatusLike {
  status: RunnerConnectionStatus;
  lastHeartbeatAt: string | null;
}

export function runnerDisplayStatus(runner: RunnerConnectionStatusLike): RunnerDisplayStatus {
  if (runner.status === "offline" && !runner.lastHeartbeatAt) {
    return "registered";
  }

  return runner.status;
}
