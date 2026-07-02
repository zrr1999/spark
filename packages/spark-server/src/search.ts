import type { DatabaseSync } from "node:sqlite";
import { workspacePath } from "./routing.ts";

export type SearchResultType = "project";

export interface ProjectSearchResult {
  id: string;
  type: SearchResultType;
  title: string;
  description: string | null;
  status: string;
  href: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  updatedAt: string;
}

export interface SearchProjectsOptions {
  activeWorkspaceId?: string | null;
  limit?: number;
}

interface ProjectSearchRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  updatedAt: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
}

const maxQueryLength = 80;
const defaultLimit = 8;
const maxLimit = 20;

export function searchProjects(
  db: DatabaseSync,
  query: string,
  options: SearchProjectsOptions = {},
): ProjectSearchResult[] {
  const normalizedQuery = query.trim().slice(0, maxQueryLength);
  if (!normalizedQuery) {
    return [];
  }

  const limit = clampLimit(options.limit);
  const pattern = `%${escapeLike(normalizedQuery)}%`;
  const prefixPattern = `${escapeLike(normalizedQuery)}%`;
  const activeWorkspaceId = options.activeWorkspaceId ?? "";

  const rows = db
    .prepare(
      `SELECT p.id,
              p.name,
              p.description,
              p.status,
              p.updated_at AS updatedAt,
              w.id AS workspaceId,
              w.slug AS workspaceSlug,
              w.name AS workspaceName
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE w.status = 'active'
         AND p.status != 'archived'
         AND (
           p.name LIKE ? ESCAPE '\\'
           OR p.slug LIKE ? ESCAPE '\\'
           OR COALESCE(p.description, '') LIKE ? ESCAPE '\\'
           OR w.name LIKE ? ESCAPE '\\'
         )
       ORDER BY
         CASE WHEN w.id = ? THEN 0 ELSE 1 END,
         CASE
           WHEN p.name LIKE ? ESCAPE '\\' THEN 0
           WHEN p.slug LIKE ? ESCAPE '\\' THEN 1
           ELSE 2
         END,
         p.updated_at DESC,
         p.created_at DESC
       LIMIT ?`,
    )
    .all(
      pattern,
      pattern,
      pattern,
      pattern,
      activeWorkspaceId,
      prefixPattern,
      prefixPattern,
      limit,
    ) as unknown as ProjectSearchRow[];

  return rows.map((row) => ({
    id: row.id,
    type: "project",
    title: row.name,
    description: row.description,
    status: row.status,
    href: workspacePath({ slug: row.workspaceSlug }, `/projects/${row.id}`),
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    workspaceName: row.workspaceName,
    updatedAt: row.updatedAt,
  }));
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clampLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) {
    return defaultLimit;
  }

  return Math.max(1, Math.min(maxLimit, Math.floor(value)));
}
