import type { DatabaseSync } from "node:sqlite";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig } from "./config.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  normalizeSparkDaemonServerUrl,
  sparkDaemonConfigForServerProfile,
  upsertSparkDaemonServerProfile,
  type SparkDaemonServerProfile,
} from "./server-profiles.js";
import {
  getWorkspaceById,
  listWorkspaces,
  rebindWorkspaceServerUrl,
  type SparkDaemonWorkspace,
} from "./store/workspaces.js";

export interface SparkDaemonUplinkStatusRow {
  serverUrl: string;
  parked: boolean;
  desired: boolean;
  runnable: boolean;
  workspaceCount: number;
  runtimeId?: string;
}

export interface SparkDaemonUplinkStatus {
  observedAt: string;
  origins: SparkDaemonUplinkStatusRow[];
}

export interface PreferWorkspaceUplinkResult {
  workspace: SparkDaemonWorkspace;
  previousServerUrl: string;
  serverUrl: string;
}

function hasRunnableCredentials(profile: SparkDaemonServerProfile): boolean {
  return Boolean(profile.runtimeId && profile.runtimeToken);
}

/** Origins the supervisor would dial (respects parked + workspace bindings). */
export function desiredUplinkServerUrls(paths: SparkPaths, db: DatabaseSync): Set<string> {
  const profiles = new Map(
    listSparkDaemonServerProfiles(paths).map((profile) => [profile.serverUrl, profile]),
  );
  const desired = new Set<string>();
  for (const workspace of listWorkspaces(db)) {
    if (!workspace.serverUrl) continue;
    const serverUrl = normalizeSparkDaemonServerUrl(workspace.serverUrl);
    const profile = profiles.get(serverUrl);
    if (!profile || profile.parked || !hasRunnableCredentials(profile)) continue;
    desired.add(serverUrl);
  }
  return desired;
}

export async function parkSparkDaemonUplink(
  paths: SparkPaths,
  serverUrl: string,
): Promise<SparkDaemonServerProfile> {
  const normalized = normalizeSparkDaemonServerUrl(serverUrl);
  const existing = getSparkDaemonServerProfile(paths, normalized);
  if (!existing) {
    throw new Error(
      `No Spark daemon profile for ${normalized}. Login or register that origin first.`,
    );
  }
  return await upsertSparkDaemonServerProfile(paths, { ...existing, parked: true });
}

export async function unparkSparkDaemonUplink(
  paths: SparkPaths,
  serverUrl: string,
): Promise<SparkDaemonServerProfile> {
  const normalized = normalizeSparkDaemonServerUrl(serverUrl);
  const existing = getSparkDaemonServerProfile(paths, normalized);
  if (!existing) {
    throw new Error(
      `No Spark daemon profile for ${normalized}. Login or register that origin first.`,
    );
  }
  const { parked: _parked, ...rest } = existing;
  return await upsertSparkDaemonServerProfile(paths, rest);
}

export function preferSparkDaemonWorkspaceUplink(
  paths: SparkPaths,
  db: DatabaseSync,
  input: { workspace: string; serverUrl: string },
): PreferWorkspaceUplinkResult {
  const serverUrl = normalizeSparkDaemonServerUrl(input.serverUrl);
  const profile = getSparkDaemonServerProfile(paths, serverUrl);
  if (!profile) {
    throw new Error(
      `No Spark daemon profile for ${serverUrl}. Login or register that origin before prefer.`,
    );
  }
  if (!hasRunnableCredentials(profile)) {
    throw new Error(
      `Spark daemon profile for ${serverUrl} is not runnable. Complete login/register first.`,
    );
  }
  if (profile.parked) {
    throw new Error(
      `Origin ${serverUrl} is parked. Unpark it before preferring a workspace onto it.`,
    );
  }

  const workspace = resolveWorkspaceForUplink(db, input.workspace);
  const rebound = rebindWorkspaceServerUrl(db, {
    workspaceId: workspace.id,
    serverUrl,
  });
  return {
    workspace: rebound.workspace,
    previousServerUrl: rebound.previousServerUrl,
    serverUrl,
  };
}

export function sparkDaemonUplinkStatus(
  paths: SparkPaths,
  db: DatabaseSync,
): SparkDaemonUplinkStatus {
  const identity = readSparkDaemonConfig(paths);
  const desired = desiredUplinkServerUrls(paths, db);
  const workspaces = listWorkspaces(db);
  const origins = listSparkDaemonServerProfiles(paths).map((profile) => {
    const config = sparkDaemonConfigForServerProfile(identity, profile);
    return {
      serverUrl: profile.serverUrl,
      parked: profile.parked === true,
      desired: desired.has(profile.serverUrl),
      runnable: hasRunnableCredentials(profile) && Boolean(config.runtimeToken),
      workspaceCount: workspaces.filter((workspace) => workspace.serverUrl === profile.serverUrl)
        .length,
      ...(profile.runtimeId ? { runtimeId: profile.runtimeId } : {}),
    } satisfies SparkDaemonUplinkStatusRow;
  });
  return { observedAt: new Date().toISOString(), origins };
}

function resolveWorkspaceForUplink(db: DatabaseSync, identifier: string): SparkDaemonWorkspace {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new Error("Workspace identifier is required.");
  }
  const byId = getWorkspaceById(db, trimmed);
  if (byId) return byId;

  const workspaces = listWorkspaces(db);
  const matches = workspaces.filter(
    (workspace) =>
      workspace.localWorkspaceKey === trimmed ||
      workspace.displayName === trimmed ||
      workspace.localPath === trimmed ||
      workspace.localPath.endsWith(`/${trimmed}`),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous workspace: ${trimmed}. Use a workspace id (${matches.map((item) => item.id).join(", ")}).`,
    );
  }
  throw new Error(`Unknown workspace: ${trimmed}`);
}
