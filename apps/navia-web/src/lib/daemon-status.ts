export type DaemonConnectionStatus = "online" | "offline" | "draining" | "disabled";
export type DaemonDisplayStatus = DaemonConnectionStatus | "registered";

export interface DaemonConnectionStatusLike {
  status: DaemonConnectionStatus;
  lastHeartbeatAt: string | null;
}

export function daemonDisplayStatus(connection: DaemonConnectionStatusLike): DaemonDisplayStatus {
  if (connection.status === "offline" && !connection.lastHeartbeatAt) {
    return "registered";
  }

  return connection.status;
}
