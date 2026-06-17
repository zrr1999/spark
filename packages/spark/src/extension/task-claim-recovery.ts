import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { nowIso, type ProjectRef, type Task } from "@zendev-lab/pi-extension-api";
import {
  defaultArtifactStore,
  type Artifact,
  type ArtifactRef,
  type JsonValue,
} from "@zendev-lab/pi-artifacts";
import type { WorkflowRunStatusSummary } from "@zendev-lab/pi-workflows";
import type { ActiveSparkRoleRunProcess } from "@zendev-lab/spark-runtime";
import { sanitizeStoreScope } from "./session-identity.ts";

export type SparkTaskClaimRecoveryReason = "claim_expired" | "review_needs_changes_owner_inactive";

export type SparkTaskClaimRecoveryRefusalReason =
  | "no_claim"
  | "current_session_claim"
  | "active_workflow_run"
  | "active_role_run_process"
  | "owner_session_recent"
  | "claim_active";

export interface SparkTaskClaimRecoveryDecision {
  recoverable: boolean;
  reason: SparkTaskClaimRecoveryReason | SparkTaskClaimRecoveryRefusalReason;
  guidance: string;
  evidence: Record<string, unknown>;
}

export interface SparkTaskClaimRecoveryArtifactInput {
  cwd: string;
  task: Task;
  projectRef: ProjectRef;
  decision: SparkTaskClaimRecoveryDecision;
  recoveredBy: string;
  now?: string;
}

interface LatestNeedsChangesReview {
  artifactRef: ArtifactRef;
  updatedAt: string;
  outcome: "needs_changes";
  summary?: string;
}

interface OwnerSessionActivity {
  updatedAt?: string;
  source: "session-goal" | "file-mtime" | "missing" | "unreadable";
}

export async function evaluateSparkTaskClaimRecovery(input: {
  cwd: string;
  task: Task;
  projectRef: ProjectRef;
  currentSessionKey: string;
  workflowRunStatus: WorkflowRunStatusSummary;
  activeRoleRunProcesses: readonly ActiveSparkRoleRunProcess[];
  now?: string;
}): Promise<SparkTaskClaimRecoveryDecision> {
  const now = input.now ?? nowIso();
  const claim = input.task.claim;
  if (!claim) return refusal("no_claim", "Task has no active claim to recover.", { now });
  if (claim.sessionId === input.currentSessionKey || claim.claimedBy === input.currentSessionKey)
    return refusal("current_session_claim", "Task is already claimed by the current session.", {
      now,
      claimedBy: claim.claimedBy,
      sessionId: claim.sessionId,
    });

  const workflowActive =
    Boolean(input.workflowRunStatus.activeRun) || input.workflowRunStatus.running > 0;
  if (workflowActive)
    return refusal(
      "active_workflow_run",
      "A Spark workflow run is still active; stale-claim recovery must not steal active work.",
      {
        now,
        workflowRunning: input.workflowRunStatus.running,
        activeWorkflowRunRef: input.workflowRunStatus.activeRun?.ref,
      },
    );

  if (input.activeRoleRunProcesses.length > 0)
    return refusal(
      "active_role_run_process",
      "At least one role-run process is still active in this workspace; recover claims only after role/background work is idle.",
      {
        now,
        activeRoleRunRefs: input.activeRoleRunProcesses.map((process) => process.runRef),
      },
    );

  const claimExpired = isTaskClaimExpired(input.task, now);
  if (claimExpired)
    return {
      recoverable: true,
      reason: "claim_expired",
      guidance:
        "Task claim lease has expired while workflow/background work is idle; it can be released and reclaimed with recovery evidence.",
      evidence: baseEvidence(input.task, now, { claimExpired }),
    };

  const latestNeedsChanges = await latestNeedsChangesReview(input.cwd, input.task);
  if (
    latestNeedsChanges &&
    isAtOrAfter(latestNeedsChanges.updatedAt, claim.heartbeatAt ?? claim.claimedAt)
  ) {
    const ownerActivity = await ownerSessionActivity(input.cwd, claim.sessionId ?? claim.claimedBy);
    if (ownerActivity.updatedAt && isAfter(ownerActivity.updatedAt, latestNeedsChanges.updatedAt)) {
      return refusal(
        "owner_session_recent",
        "The owner session has activity after the latest needs_changes review; do not recover this claim yet.",
        {
          ...baseEvidence(input.task, now, { claimExpired }),
          latestNeedsChanges,
          ownerActivity,
        },
      );
    }
    return {
      recoverable: true,
      reason: "review_needs_changes_owner_inactive",
      guidance:
        "Latest reviewer verdict is needs_changes, no workflow/role work is active, and the owner session has no newer activity; the claim can be released and reclaimed with recovery evidence.",
      evidence: {
        ...baseEvidence(input.task, now, { claimExpired }),
        latestNeedsChanges,
        ownerActivity,
      },
    };
  }

  return refusal(
    "claim_active",
    "Task claim is still within its lease and no newer needs_changes review with inactive owner evidence was found.",
    {
      ...baseEvidence(input.task, now, { claimExpired }),
      latestNeedsChanges,
    },
  );
}

export async function recordSparkTaskClaimRecoveryArtifact(
  input: SparkTaskClaimRecoveryArtifactInput,
): Promise<{ ref: ArtifactRef }> {
  const now = input.now ?? nowIso();
  const body = toJsonValue({
    action: "recover_task_claim",
    taskRef: input.task.ref,
    taskName: input.task.name,
    taskTitle: input.task.title,
    projectRef: input.projectRef,
    recoveredBy: input.recoveredBy,
    previousClaim: input.task.claim,
    decision: input.decision,
    recoveredAt: now,
  });
  const artifact = await defaultArtifactStore(input.cwd).put({
    kind: "record",
    title: `Recovered Spark task claim for @${input.task.name}`,
    format: "json",
    body,
    provenance: {
      producer: "spark",
      projectRef: input.projectRef,
      taskRef: input.task.ref,
    },
  });
  return { ref: artifact.ref };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function isTaskClaimExpired(task: Pick<Task, "claim">, now = nowIso()): boolean {
  const expiresAt = task.claim?.expiresAt?.trim();
  if (!expiresAt) return true;
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) return true;
  return expiresMs <= nowMs;
}

export function staleClaimStatusHint(input: {
  task: Task;
  currentSessionKey: string;
  workflowIdle: boolean;
  now?: string;
}): Record<string, unknown> | undefined {
  const claim = input.task.claim;
  if (!claim) return undefined;
  if (claim.sessionId === input.currentSessionKey || claim.claimedBy === input.currentSessionKey)
    return undefined;
  const expired = isTaskClaimExpired(input.task, input.now);
  return {
    taskRef: input.task.ref,
    name: input.task.name,
    title: input.task.title,
    claimedBy: claim.claimedBy,
    sessionId: claim.sessionId,
    claimedAt: claim.claimedAt,
    heartbeatAt: claim.heartbeatAt,
    expiresAt: claim.expiresAt,
    expired,
    workflowIdle: input.workflowIdle,
    guidance: input.workflowIdle
      ? expired
        ? `Expired claim can be recovered by claiming @${input.task.name}; Spark will record recovery evidence before reclaiming.`
        : `If owner activity is stale or latest review is needs_changes, retry claim for @${input.task.name}; Spark will refuse active/recent owners.`
      : "Background workflow/role work is active; wait or inspect run_status before recovery.",
  };
}

function refusal(
  reason: SparkTaskClaimRecoveryRefusalReason,
  guidance: string,
  evidence: Record<string, unknown>,
): SparkTaskClaimRecoveryDecision {
  return { recoverable: false, reason, guidance, evidence };
}

function baseEvidence(
  task: Task,
  now: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    now,
    taskRef: task.ref,
    taskName: task.name,
    taskStatus: task.status,
    claimedBy: task.claim?.claimedBy,
    sessionId: task.claim?.sessionId,
    claimedAt: task.claim?.claimedAt,
    heartbeatAt: task.claim?.heartbeatAt,
    expiresAt: task.claim?.expiresAt,
    ...extra,
  };
}

async function latestNeedsChangesReview(
  cwd: string,
  task: Task,
): Promise<LatestNeedsChangesReview | undefined> {
  const reviews = await defaultArtifactStore(cwd).list({ taskRef: task.ref, producer: "review" });
  return reviews
    .flatMap((artifact) => {
      const outcome = reviewOutcome(artifact);
      if (outcome !== "needs_changes") return [];
      return [
        {
          artifactRef: artifact.ref,
          updatedAt: artifact.updatedAt,
          outcome,
          summary: reviewSummary(artifact),
        } satisfies LatestNeedsChangesReview,
      ];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function reviewOutcome(artifact: Artifact): "needs_changes" | undefined {
  const body = artifact.body;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const verdict = (body as { verdict?: unknown }).verdict;
    if (typeof verdict === "object" && verdict !== null && !Array.isArray(verdict)) {
      return (verdict as { outcome?: unknown }).outcome === "needs_changes"
        ? "needs_changes"
        : undefined;
    }
  }
  return undefined;
}

function reviewSummary(artifact: Artifact): string | undefined {
  const body = artifact.body;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const verdict = (body as { verdict?: unknown }).verdict;
    if (typeof verdict === "object" && verdict !== null && !Array.isArray(verdict)) {
      const summary = (verdict as { summary?: unknown }).summary;
      return typeof summary === "string" ? summary : undefined;
    }
  }
  return undefined;
}

async function ownerSessionActivity(cwd: string, owner: string): Promise<OwnerSessionActivity> {
  const filePath = join(cwd, ".spark", "session-goals", `${sanitizeStoreScope(owner)}.json`);
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as { goal?: { updatedAt?: unknown } };
    const updatedAt = parsed.goal?.updatedAt;
    if (typeof updatedAt === "string" && updatedAt.trim())
      return { updatedAt, source: "session-goal" };
    const info = await stat(filePath);
    return { updatedAt: info.mtime.toISOString(), source: "file-mtime" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source: "missing" };
    return { source: "unreadable" };
  }
}

function isAtOrAfter(left: string, right: string | undefined): boolean {
  if (!right) return true;
  return Date.parse(left) >= Date.parse(right);
}

function isAfter(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right);
}
