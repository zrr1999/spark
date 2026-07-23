import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";

export function nowIso() {
  return new Date().toISOString();
}

export function toJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

export function withTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface AppendEventInput {
  workspaceId?: string | null;
  projectId?: string | null;
  actorKind: "user" | "runtime" | "server";
  actorId?: string | null;
  kind: string;
  subjectKind?: string | null;
  subjectId?: string | null;
  payload?: unknown;
  createdAt?: string;
}

export function appendEvent(db: DatabaseSync, input: AppendEventInput) {
  const sequenceRow = db
    .prepare(
      `UPDATE event_ingest_sequence
       SET value = value + 1
       WHERE singleton = 1
       RETURNING value`,
    )
    .get() as { value: number } | undefined;
  if (!sequenceRow) {
    throw new Error("Spark event ingest sequence is not initialized");
  }
  const event = {
    id: createId("evt"),
    createdAt: input.createdAt ?? nowIso(),
    sequence: sequenceRow.value,
  };

  db.prepare(
    `INSERT INTO events
      (id, ingest_sequence, workspace_id, project_id, actor_kind, actor_id, kind, subject_kind, subject_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.sequence,
    input.workspaceId ?? null,
    input.projectId ?? null,
    input.actorKind,
    input.actorId ?? null,
    input.kind,
    input.subjectKind ?? null,
    input.subjectId ?? null,
    toJson(input.payload),
    event.createdAt,
  );

  return event;
}

interface CreateWorkspaceInput {
  slug: string;
  name: string;
  description?: string | null;
  settings?: unknown;
  profileSource?: {
    sourceKind: "builtin" | "git";
    profileId: string;
    profileName: string;
    schemaVersion: string;
    repoUrl?: string | null;
    sourcePath?: string | null;
    commitHash?: string | null;
  } | null;
  agentSpecs?: Array<{
    name: string;
    source: "builtin" | "workspace" | "imported";
    status: "active" | "disabled" | "archived";
    description?: string | null;
    config?: unknown;
  }>;
  resources?: Array<{
    kind: "repo" | "doc" | "url" | "file" | "secret_ref" | "tool" | "other";
    name: string;
    uri?: string | null;
    status: "available" | "degraded" | "unavailable" | "archived";
    config?: unknown;
  }>;
  createdAt?: string;
}

export interface CreateWorkspaceWithLeaseInput extends CreateWorkspaceInput {
  runtimeWorkspaceBindingId: string;
}

/** @deprecated Prefer {@link CreateWorkspaceWithLeaseInput}. */
export type CreateWorkspaceWithOwnerBindingInput = CreateWorkspaceWithLeaseInput;

export interface WorkspaceProjection {
  id: string;
  /** @deprecated Prefer {@link WorkspaceProjection.leaseId}. */
  ownerBindingId: string;
  /** Active Cockpit origin lease id. */
  leaseId: string;
  createdAt: string;
  updatedAt: string;
}

export function createWorkspaceWithLease(db: DatabaseSync, input: CreateWorkspaceWithLeaseInput) {
  return withTransaction(db, () => {
    const binding = db
      .prepare("SELECT id FROM runtime_workspace_bindings WHERE id = ? AND status != 'archived'")
      .get(input.runtimeWorkspaceBindingId) as { id: string } | undefined;

    if (!binding) {
      throw new Error(
        `Spark daemon workspace binding is not available: ${input.runtimeWorkspaceBindingId}`,
      );
    }

    const existing = db
      .prepare(
        `SELECT id,
                created_at AS createdAt
         FROM workspaces
         WHERE slug = ? AND status = 'active'
         LIMIT 1`,
      )
      .get(input.slug) as { id: string; createdAt: string } | undefined;

    return upsertWorkspaceProjection(db, input, input.runtimeWorkspaceBindingId, existing ?? null);
  });
}

/** @deprecated Prefer {@link createWorkspaceWithLease}. */
export const createWorkspaceWithOwnerBinding = createWorkspaceWithLease;

export interface UnbindWorkspaceLeaseInput {
  workspaceId: string;
  expectedRuntimeWorkspaceBindingId?: string;
  actorId?: string;
  endedAt?: string;
}

export type UnbindWorkspaceLeaseResult =
  | {
      outcome: "unbound";
      leaseId: string;
      /** @deprecated Prefer {@link UnbindWorkspaceLeaseResult} `leaseId`. */
      ownerBindingId: string;
      runtimeWorkspaceBindingId: string;
      endedAt: string;
    }
  | { outcome: "already_unbound"; endedAt: string };

/** @deprecated Prefer {@link UnbindWorkspaceLeaseInput}. */
export type UnbindWorkspaceOwnerInput = UnbindWorkspaceLeaseInput;

/** @deprecated Prefer {@link UnbindWorkspaceLeaseResult}. */
export type UnbindWorkspaceOwnerResult = UnbindWorkspaceLeaseResult;

/**
 * End only the Cockpit origin lease projection. The daemon-owned directory and its
 * runtime binding row remain intact so a reconnect can observe the unbound state
 * and the directory can later be attached to another Cockpit workspace.
 */
export function unbindWorkspaceLease(
  db: DatabaseSync,
  input: UnbindWorkspaceLeaseInput,
): UnbindWorkspaceLeaseResult {
  return withTransaction(db, () => {
    const endedAt = input.endedAt ?? nowIso();
    const active = db
      .prepare(
        `SELECT id,
                runtime_workspace_binding_id AS runtimeWorkspaceBindingId
         FROM workspace_leases
         WHERE workspace_id = ? AND ended_at IS NULL
         LIMIT 1`,
      )
      .get(input.workspaceId) as { id: string; runtimeWorkspaceBindingId: string } | undefined;
    if (!active) return { outcome: "already_unbound", endedAt };
    if (
      input.expectedRuntimeWorkspaceBindingId &&
      input.expectedRuntimeWorkspaceBindingId !== active.runtimeWorkspaceBindingId
    ) {
      throw new Error("Workspace lease changed before the unbind request was applied.");
    }

    const updated = db
      .prepare(
        `UPDATE workspace_leases
         SET ended_at = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(endedAt, active.id);
    if (updated.changes !== 1) {
      throw new Error("Workspace lease changed before the unbind request was applied.");
    }
    appendEvent(db, {
      workspaceId: input.workspaceId,
      actorKind: "user",
      actorId: input.actorId ?? null,
      kind: "workspace.lease_unbound",
      subjectKind: "workspace_lease",
      subjectId: active.id,
      payload: { runtimeWorkspaceBindingId: active.runtimeWorkspaceBindingId },
      createdAt: endedAt,
    });
    return {
      outcome: "unbound",
      leaseId: active.id,
      ownerBindingId: active.id,
      runtimeWorkspaceBindingId: active.runtimeWorkspaceBindingId,
      endedAt,
    };
  });
}

/** @deprecated Prefer {@link unbindWorkspaceLease}. */
export const unbindWorkspaceOwner = unbindWorkspaceLease;

export interface ArchiveWorkspaceInput {
  workspaceId: string;
  actorId?: string;
  archivedAt?: string;
}

export type ArchiveWorkspaceResult =
  | {
      outcome: "archived";
      workspaceId: string;
      previousSlug: string;
      archivedSlug: string;
      archivedAt: string;
      leaseUnbound: boolean;
    }
  | { outcome: "already_archived"; workspaceId: string; archivedAt: string }
  | { outcome: "missing" };

/**
 * Remove a workspace from the Cockpit directory without deleting daemon-owned
 * local directories or sessions. Archives the workspace row (freeing its slug)
 * and ends any active Cockpit origin lease.
 */
export function archiveWorkspace(
  db: DatabaseSync,
  input: ArchiveWorkspaceInput,
): ArchiveWorkspaceResult {
  return withTransaction(db, () => {
    const archivedAt = input.archivedAt ?? nowIso();
    const workspace = db
      .prepare(
        `SELECT id,
                slug,
                status
         FROM workspaces
         WHERE id = ?
         LIMIT 1`,
      )
      .get(input.workspaceId) as { id: string; slug: string; status: string } | undefined;
    if (!workspace) return { outcome: "missing" };
    if (workspace.status === "archived") {
      return { outcome: "already_archived", workspaceId: workspace.id, archivedAt };
    }

    const activeLease = db
      .prepare(
        `SELECT id,
                runtime_workspace_binding_id AS runtimeWorkspaceBindingId
         FROM workspace_leases
         WHERE workspace_id = ? AND ended_at IS NULL
         LIMIT 1`,
      )
      .get(workspace.id) as { id: string; runtimeWorkspaceBindingId: string } | undefined;

    let leaseUnbound = false;
    if (activeLease) {
      const updated = db
        .prepare(
          `UPDATE workspace_leases
           SET ended_at = ?
           WHERE id = ? AND ended_at IS NULL`,
        )
        .run(archivedAt, activeLease.id);
      if (updated.changes === 1) {
        leaseUnbound = true;
        appendEvent(db, {
          workspaceId: workspace.id,
          actorKind: "user",
          actorId: input.actorId ?? null,
          kind: "workspace.lease_unbound",
          subjectKind: "workspace_lease",
          subjectId: activeLease.id,
          payload: { runtimeWorkspaceBindingId: activeLease.runtimeWorkspaceBindingId },
          createdAt: archivedAt,
        });
      }
    }

    // Free the human slug so a new workspace can reuse it after removal.
    const archivedSlug = `archived-${workspace.id}`;
    const archived = db
      .prepare(
        `UPDATE workspaces
         SET status = 'archived',
             slug = ?,
             updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(archivedSlug, archivedAt, workspace.id);
    if (archived.changes !== 1) {
      throw new Error("Workspace changed before the archive request was applied.");
    }

    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "user",
      actorId: input.actorId ?? null,
      kind: "workspace.archived",
      subjectKind: "workspace",
      subjectId: workspace.id,
      payload: { previousSlug: workspace.slug, archivedSlug },
      createdAt: archivedAt,
    });

    return {
      outcome: "archived",
      workspaceId: workspace.id,
      previousSlug: workspace.slug,
      archivedSlug,
      archivedAt,
      leaseUnbound,
    };
  });
}

function upsertWorkspaceProjection(
  db: DatabaseSync,
  input: CreateWorkspaceInput,
  runtimeWorkspaceBindingId: string,
  existing: { id: string; createdAt: string } | null,
): WorkspaceProjection {
  const timestamp = input.createdAt ?? nowIso();
  const workspace = {
    id: existing?.id ?? createId("ws"),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  if (existing) {
    db.prepare(
      `UPDATE workspaces
       SET name = ?,
           description = ?,
           settings_json = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.description ?? null,
      toJson(input.settings ?? {}),
      timestamp,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      workspace.id,
      input.slug,
      input.name,
      input.description ?? null,
      toJson(input.settings ?? {}),
      timestamp,
      timestamp,
    );
  }

  const ownerBindingId = ensureActiveOwnerBinding(
    db,
    workspace.id,
    runtimeWorkspaceBindingId,
    timestamp,
    { replaceExisting: !existing },
  );
  const shouldSeedWorkspace = !hasWorkspaceProfileSource(db, workspace.id);

  if (input.profileSource && shouldSeedWorkspace) {
    db.prepare(
      `INSERT INTO workspace_profile_sources
        (id, workspace_id, source_kind, profile_id, profile_name, schema_version, repo_url, source_path, commit_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("wpsrc"),
      workspace.id,
      input.profileSource.sourceKind,
      input.profileSource.profileId,
      input.profileSource.profileName,
      input.profileSource.schemaVersion,
      input.profileSource.repoUrl ?? null,
      input.profileSource.sourcePath ?? null,
      input.profileSource.commitHash ?? null,
      timestamp,
    );
  }

  for (const resource of shouldSeedWorkspace ? (input.resources ?? []) : []) {
    db.prepare(
      `INSERT INTO resources
        (id, workspace_id, kind, name, uri, status, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("res"),
      workspace.id,
      resource.kind,
      resource.name,
      resource.uri ?? null,
      resource.status,
      toJson(resource.config ?? {}),
      timestamp,
      timestamp,
    );
  }

  for (const agent of shouldSeedWorkspace ? (input.agentSpecs ?? []) : []) {
    db.prepare(
      `INSERT INTO agent_specs
        (id, workspace_id, name, source, status, description, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, name) DO UPDATE SET
         source = excluded.source,
         status = excluded.status,
         description = excluded.description,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    ).run(
      createId("agent"),
      workspace.id,
      agent.name,
      agent.source,
      agent.status,
      agent.description ?? null,
      toJson(agent.config ?? {}),
      timestamp,
      timestamp,
    );
  }

  if (shouldSeedWorkspace) {
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "server",
      kind: "workspace.created",
      subjectKind: "workspace",
      subjectId: workspace.id,
      payload: {
        runtimeWorkspaceBindingId,
        profileSource: input.profileSource
          ? {
              sourceKind: input.profileSource.sourceKind,
              profileId: input.profileSource.profileId,
              commitHash: input.profileSource.commitHash ?? null,
            }
          : null,
      },
      createdAt: timestamp,
    });
  }

  return { ...workspace, ownerBindingId, leaseId: ownerBindingId };
}

function ensureActiveOwnerBinding(
  db: DatabaseSync,
  workspaceId: string,
  runtimeWorkspaceBindingId: string,
  timestamp: string,
  options: { replaceExisting: boolean },
): string {
  const activeWorkspaceForBinding = db
    .prepare(
      `SELECT workspace_id AS workspaceId
       FROM workspace_leases
       WHERE runtime_workspace_binding_id = ? AND ended_at IS NULL
       LIMIT 1`,
    )
    .get(runtimeWorkspaceBindingId) as { workspaceId: string } | undefined;
  if (activeWorkspaceForBinding && activeWorkspaceForBinding.workspaceId !== workspaceId) {
    throw new Error(
      `Runtime workspace binding already belongs to another Cockpit workspace: ${runtimeWorkspaceBindingId}`,
    );
  }
  const active = db
    .prepare(
      `SELECT id,
              runtime_workspace_binding_id AS runtimeWorkspaceBindingId
       FROM workspace_leases
       WHERE workspace_id = ? AND ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { id: string; runtimeWorkspaceBindingId: string } | undefined;
  if (active?.runtimeWorkspaceBindingId === runtimeWorkspaceBindingId) {
    return active.id;
  }
  if (active && !options.replaceExisting) {
    throw new Error(`Workspace already has an active origin lease: ${workspaceId}`);
  }

  db.prepare(
    `UPDATE workspace_leases
     SET ended_at = ?
     WHERE workspace_id = ? AND ended_at IS NULL`,
  ).run(timestamp, workspaceId);

  const ownerBindingId = createId("wob");
  db.prepare(
    `INSERT INTO workspace_leases
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
  ).run(ownerBindingId, workspaceId, runtimeWorkspaceBindingId, timestamp, timestamp);
  return ownerBindingId;
}

function hasWorkspaceProfileSource(db: DatabaseSync, workspaceId: string): boolean {
  const existing = db
    .prepare("SELECT id FROM workspace_profile_sources WHERE workspace_id = ? LIMIT 1")
    .get(workspaceId);
  return Boolean(existing);
}
