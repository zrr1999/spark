import { SparkUpdateManager } from "@zendev-lab/spark-update";

export interface CockpitUpdateProjection {
  managed: boolean;
  policy: "manual" | "notify" | "auto";
  channel: "latest" | "next";
  current: string | null;
  available: string | null;
  pending: string | null;
  quarantined: Array<{ version: string; reason: string; quarantinedAt: string }>;
  lastCheckAt: string | null;
  nextRetryAt: string | null;
  repairCommand: string | null;
}

/** Read-only Cockpit projection. Installation and rollback remain updater-owned. */
export async function readCockpitUpdateProjection(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CockpitUpdateProjection> {
  const status = await new SparkUpdateManager({ env: options.env }).status();
  return {
    managed: status.managed,
    policy: status.config.policy,
    channel: status.config.channel,
    current: status.state.currentVersion ?? null,
    available: status.state.availableVersion ?? null,
    pending: status.state.pendingVersion ?? null,
    quarantined: status.state.quarantined,
    lastCheckAt: status.state.lastCheckAt ?? null,
    nextRetryAt: status.state.failure?.nextRetryAt ?? null,
    repairCommand: status.repairCommand ?? null,
  };
}
