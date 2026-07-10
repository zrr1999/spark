export interface ChannelStatusSnapshot {
  plane: "daemon";
  resource: "channel";
  workspaceId: string;
  configPath: string;
  available: true;
  configured: boolean;
  ingressEnabled: boolean;
  state: "unconfigured" | "running" | "stopped" | "degraded";
  adapters: Array<{ id: string; type: string; running: boolean }>;
  routes: Array<{ name: string; adapter: string; recipient: string }>;
  observedAt: string;
  lastReloadedAt?: string;
  error?: string;
  text: string;
}
