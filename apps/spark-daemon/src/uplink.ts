import type { DatabaseSync } from "node:sqlite";
import { createId, type HumanRequestCreatedPayload } from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig } from "./config.js";
import {
  leaseTransferDecisionFromAnswers,
  LEASE_TRANSFER_TIMEOUT_MS,
  SparkDaemonLeaseTransferBroker,
  type LeaseTransferRequest,
  type LeaseTransferSettlement,
} from "./core/lease-transfer.js";
import type { SparkDaemonHumanWaitRegistry } from "./core/human-waits.js";
import { runtimeEnvelope } from "./protocol/outbound.js";
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
  isBorrowedWorkspace,
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
  transfer?: {
    transferId: string;
    decision: LeaseTransferSettlement["decision"];
    source: LeaseTransferSettlement["source"];
  };
}

export interface PreferWorkspaceUplinkWithTransferOptions {
  transfers: SparkDaemonLeaseTransferBroker;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  getRuntimeId?: (serverUrl: string) => string | undefined;
  onOutboxReady?: () => void;
  onTransferPrompted?: (request: LeaseTransferRequest) => void;
  timeoutMs?: number;
  /** Skip consent even when occupied (operator override). */
  force?: boolean;
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

/**
 * Prefer with L3-transfer consent: empty occupancy applies immediately;
 * interactive occupancy prompts occupying sessions and auto-authorizes after timeout.
 */
export async function preferSparkDaemonWorkspaceUplinkWithTransfer(
  paths: SparkPaths,
  db: DatabaseSync,
  input: { workspace: string; serverUrl: string },
  options: PreferWorkspaceUplinkWithTransferOptions,
): Promise<PreferWorkspaceUplinkResult> {
  const targetServerUrl = normalizeSparkDaemonServerUrl(input.serverUrl);
  const profile = getSparkDaemonServerProfile(paths, targetServerUrl);
  if (!profile) {
    throw new Error(
      `No Spark daemon profile for ${targetServerUrl}. Login or register that origin before prefer.`,
    );
  }
  if (!hasRunnableCredentials(profile)) {
    throw new Error(
      `Spark daemon profile for ${targetServerUrl} is not runnable. Complete login/register first.`,
    );
  }
  if (profile.parked) {
    throw new Error(
      `Origin ${targetServerUrl} is parked. Unpark it before preferring a workspace onto it.`,
    );
  }

  const workspace = resolveWorkspaceForUplink(db, input.workspace);
  const previousServerUrl = normalizeSparkDaemonServerUrl(workspace.serverUrl);
  if (previousServerUrl === targetServerUrl) {
    return {
      workspace,
      previousServerUrl,
      serverUrl: targetServerUrl,
    };
  }

  const occupied = isBorrowedWorkspace(db, workspace.id);
  if (!occupied || options.force) {
    const preferred = preferSparkDaemonWorkspaceUplink(paths, db, input);
    await parkPreviousOriginIfIdle(paths, db, preferred.previousServerUrl, preferred.serverUrl);
    return preferred;
  }

  const humanRequestId = createId("hreq");
  const { request, settlement } = options.transfers.request({
    workspaceId: workspace.id,
    workspaceDisplayName: workspace.displayName,
    previousServerUrl,
    targetServerUrl,
    humanRequestId,
    timeoutMs: options.timeoutMs ?? LEASE_TRANSFER_TIMEOUT_MS,
  });

  promptLeaseTransfer(options, request, humanRequestId, workspace);
  options.onTransferPrompted?.(request);

  const settled = await settlement;
  if (request.humanRequestId && options.humanWaits) {
    options.humanWaits.deliver({
      humanRequestId: request.humanRequestId,
      status: settled.decision === "reject" ? "cancelled" : "answered",
      answers:
        settled.decision === "reject"
          ? { decision: "reject" }
          : { decision: settled.decision === "auto-authorize" ? "accept" : "accept" },
    });
    options.onOutboxReady?.();
  }
  if (settled.decision === "reject") {
    throw new Error(
      `Lease transfer for ${workspace.displayName} was rejected by an occupying session.`,
    );
  }

  const preferred = preferSparkDaemonWorkspaceUplink(paths, db, input);
  await parkPreviousOriginIfIdle(paths, db, preferred.previousServerUrl, preferred.serverUrl);
  return {
    ...preferred,
    transfer: {
      transferId: settled.transferId,
      decision: settled.decision,
      source: settled.source,
    },
  };
}

function promptLeaseTransfer(
  options: PreferWorkspaceUplinkWithTransferOptions,
  request: LeaseTransferRequest,
  humanRequestId: string,
  workspace: SparkDaemonWorkspace,
): void {
  if (!options.humanWaits) return;
  const runtimeId = options.getRuntimeId?.(request.previousServerUrl);

  const payload: HumanRequestCreatedPayload = {
    kind: "ask_user",
    delivery: "blocking",
    title: "Transfer workspace lease?",
    prompt: `Transfer the active lease for “${request.workspaceDisplayName}” to ${request.targetServerUrl}? Occupying sessions can accept or reject. Unanswered requests auto-authorize after 30 seconds.`,
    questions: [
      {
        id: "decision",
        type: "single",
        prompt: "Transfer this lease?",
        required: true,
        options: [
          { value: "accept", label: "Transfer" },
          { value: "reject", label: "Keep current lease" },
        ],
      },
    ],
    context: {
      leaseTransferId: request.transferId,
      targetServerUrl: request.targetServerUrl,
      previousServerUrl: request.previousServerUrl,
      workspaceId: request.workspaceId,
    },
    contextArtifactRefs: [],
  };

  const bindingId = workspace.serverBindingId ?? workspace.id;
  const registrationInput = {
    humanRequestId,
    kind: "ask_user" as const,
    title: payload.title,
    prompt: payload.prompt,
    questions: payload.questions,
    context: payload.context,
    delivery: "blocking" as const,
    workspaceBindingId: bindingId,
    workspaceId: workspace.serverWorkspaceId ?? workspace.id,
  };

  const registration = runtimeId
    ? options.humanWaits.register(registrationInput, {
        messageId: createId("msg"),
        kind: "human.request.created",
        envelope: runtimeEnvelope("human.request.created", payload, {
          runtimeId,
          workspaceBindingId: bindingId,
          workspaceId: workspace.serverWorkspaceId ?? workspace.id,
          humanRequestId,
        }),
      })
    : options.humanWaits.register(registrationInput);
  options.onOutboxReady?.();

  if (registration.response) {
    void registration.response.then((response) => {
      const decision = leaseTransferDecisionFromAnswers(
        response.status === "cancelled" ? "cancelled" : "answered",
        response.answers,
      );
      options.transfers.respondByHumanRequest(humanRequestId, decision, "cockpit");
    });
  }
}

async function parkPreviousOriginIfIdle(
  paths: SparkPaths,
  db: DatabaseSync,
  previousServerUrl: string,
  currentServerUrl: string,
): Promise<void> {
  const previous = normalizeSparkDaemonServerUrl(previousServerUrl);
  const current = normalizeSparkDaemonServerUrl(currentServerUrl);
  if (!previous || previous === current) return;
  const remaining = listWorkspaces(db).filter(
    (workspace) => normalizeSparkDaemonServerUrl(workspace.serverUrl) === previous,
  );
  if (remaining.length > 0) return;
  try {
    await parkSparkDaemonUplink(paths, previous);
  } catch {
    // Prefer already applied; park is best-effort when the previous origin is empty.
  }
}

export {
  leaseTransferDecisionFromAnswers,
  SparkDaemonLeaseTransferBroker,
  LEASE_TRANSFER_TIMEOUT_MS,
};
export type { LeaseTransferRequest, LeaseTransferSettlement };

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
