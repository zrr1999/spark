import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asciiSlug } from "@zendev-lab/spark-system";

/** Top-level Cockpit route segments that cannot be workspace slugs. */
export const reservedWorkbenchPathSegments = [
  "api",
  "setup",
  "logout",
  "login",
  "daemon",
  "workspaces",
  "settings",
  "sessions",
  "agents",
  "projects",
  "inbox",
  "repos",
  "artifacts",
] as const;

const reservedTopLevelSegments = new Set<string>(reservedWorkbenchPathSegments);

export function isReservedWorkbenchPathSegment(segment: string): boolean {
  return reservedTopLevelSegments.has(segment.trim().toLowerCase());
}

export interface WorkspaceDirectoryIdentity {
  name: string;
  slug: string;
}

/**
 * Derive the single workspace identity from a daemon-local directory path.
 * Basename is both the display name and the preferred URL slug source.
 */
export function workspaceIdentityFromLocalPath(
  localPath: string | null | undefined,
): WorkspaceDirectoryIdentity | null {
  const trimmed = localPath?.trim() ?? "";
  if (!trimmed) return null;
  const base = basename(trimmed.replaceAll("\\", "/")).trim();
  if (!base || base === "." || base === "..") return null;
  return {
    name: base,
    slug: asciiSlug(base, { fallback: "workspace", maxLength: 48 }),
  };
}

/**
 * Prefer path basename over a free-floating registration display label.
 */
export function resolveWorkspaceDirectoryDisplayName(input: {
  localPath?: string | null;
  displayName: string;
}): string {
  return workspaceIdentityFromLocalPath(input.localPath)?.name ?? input.displayName.trim();
}

/**
 * Keep workspaces.name/slug and the active owner binding display_name aligned
 * with the bound local directory. Reserved or colliding slugs keep the current slug.
 */
export function syncWorkspaceIdentityFromLocalPath(
  db: DatabaseSync,
  workspaceId: string,
  localPath: string | null | undefined,
  now: string,
): WorkspaceDirectoryIdentity | null {
  const identity = workspaceIdentityFromLocalPath(localPath);
  if (!identity) return null;

  const current = db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(workspaceId) as { id: string; slug: string; name: string } | undefined;
  if (!current) return null;

  let nextSlug = current.slug;
  if (
    identity.slug !== current.slug &&
    !isReservedWorkbenchPathSegment(identity.slug) &&
    !activeWorkspaceSlugTaken(db, identity.slug, workspaceId)
  ) {
    nextSlug = identity.slug;
  }

  db.prepare(
    `UPDATE workspaces
     SET name = ?,
         slug = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(identity.name, nextSlug, now, workspaceId);

  db.prepare(
    `UPDATE runtime_workspace_bindings
     SET display_name = ?,
         updated_at = ?
     WHERE id = (
       SELECT runtime_workspace_binding_id
       FROM workspace_owner_bindings
       WHERE workspace_id = ? AND ended_at IS NULL
       LIMIT 1
     )`,
  ).run(identity.name, now, workspaceId);

  return { name: identity.name, slug: nextSlug };
}

function activeWorkspaceSlugTaken(db: DatabaseSync, slug: string, workspaceId: string): boolean {
  const duplicate = db
    .prepare(
      `SELECT id
       FROM workspaces
       WHERE slug = ?
         AND id != ?
         AND status = 'active'
       LIMIT 1`,
    )
    .get(slug, workspaceId) as { id: string } | undefined;
  return Boolean(duplicate);
}
