const STORAGE_KEY = "spark.cockpit.occupancy.clientId";
const HEARTBEAT_INTERVAL_MS = 15_000;

export function readOrCreateOccupancyClientId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
    const created = `wcl_cockpit_${crypto.randomUUID().replaceAll("-", "")}`;
    window.sessionStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return `wcl_cockpit_${crypto.randomUUID().replaceAll("-", "")}`;
  }
}

export function startWorkspaceOccupancyHeartbeat(options: {
  workspaceId: string;
  clientId: string;
  sessionId?: string;
}): () => void {
  const { workspaceId, clientId } = options;
  const sessionId = options.sessionId ?? clientId;
  let stopped = false;
  let heartbeatTimer: number | undefined;

  const post = (action: "attach" | "heartbeat" | "release") =>
    fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/occupancy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, clientId, sessionId }),
      keepalive: action === "release",
    }).catch(() => undefined);

  void post("attach").then(() => {
    if (stopped) return;
    heartbeatTimer = window.setInterval(() => {
      void post("heartbeat");
    }, HEARTBEAT_INTERVAL_MS);
  });

  const release = () => {
    if (stopped) return;
    stopped = true;
    if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
    void post("release");
  };

  window.addEventListener("pagehide", release);
  window.addEventListener("beforeunload", release);

  return () => {
    window.removeEventListener("pagehide", release);
    window.removeEventListener("beforeunload", release);
    release();
  };
}
