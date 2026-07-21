import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createWorkspaceAccessToken,
  listWorkspaceAccessTokens,
  revokeWorkspaceAccessToken,
  type WorkspaceAccessTokenSummary,
} from "@zendev-lab/spark-cockpit-coordination/workspace-access";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-cockpit-db";

export type WorkspaceAccessOperation = "create" | "list" | "revoke";

export interface WorkspaceAccessCliCommand {
  operation: string;
  workspaceRef?: string;
  databasePath?: string;
  label?: string;
  tokenId?: string;
  json?: boolean;
}

export interface WorkspaceAccessCreateResult {
  plane: "cockpit";
  resource: "workspace-access";
  operation: "create";
  status: "created";
  workspaceId: string;
  workspaceSlug: string;
  tokenId: string;
  token: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  loginPath: string;
  text: string;
}

export interface WorkspaceAccessListResult {
  plane: "cockpit";
  resource: "workspace-access";
  operation: "list";
  status: "ok";
  workspaceId: string;
  workspaceSlug: string;
  tokens: WorkspaceAccessTokenSummary[];
  text: string;
}

export interface WorkspaceAccessRevokeResult {
  plane: "cockpit";
  resource: "workspace-access";
  operation: "revoke";
  status: "revoked" | "not_found";
  workspaceId: string;
  tokenId: string;
  text: string;
}

export type WorkspaceAccessCliResult =
  | WorkspaceAccessCreateResult
  | WorkspaceAccessListResult
  | WorkspaceAccessRevokeResult;

interface ResolvedWorkspace {
  id: string;
  slug: string;
  name: string;
}

export async function handleWorkspaceAccessCliCommand(
  command: WorkspaceAccessCliCommand,
): Promise<WorkspaceAccessCliResult> {
  const operation = command.operation as WorkspaceAccessOperation;
  if (operation !== "create" && operation !== "list" && operation !== "revoke") {
    throw new Error(
      `unknown spark cockpit workspace access operation: ${command.operation}. Use create, list, or revoke.`,
    );
  }
  const workspaceRef = command.workspaceRef?.trim();
  if (!workspaceRef) {
    throw new Error("spark cockpit workspace access requires --workspace <id>");
  }
  if (operation === "revoke" && !command.tokenId?.trim()) {
    throw new Error("spark cockpit workspace access revoke requires --id <token-id>");
  }

  const databasePath = resolve(command.databasePath?.trim() || defaultDatabasePath());
  const db = openDatabase({ path: databasePath });
  try {
    migrate(db);
    const workspace = resolveWorkspaceRef(db, workspaceRef);
    switch (operation) {
      case "create":
        return createAccess(db, workspace, command.label);
      case "list":
        return listAccess(db, workspace);
      case "revoke":
        return revokeAccess(db, workspace, command.tokenId!.trim());
      default: {
        const _exhaustive: never = operation;
        void _exhaustive;
        throw new Error(`unhandled spark cockpit workspace access operation: ${command.operation}`);
      }
    }
  } finally {
    db.close();
  }
}

export function resolveWorkspaceRef(db: DatabaseSync, ref: string): ResolvedWorkspace {
  const trimmed = ref.trim();
  const byId = db
    .prepare(
      `SELECT id, slug, name FROM workspaces
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(trimmed) as ResolvedWorkspace | undefined;
  if (byId) return byId;

  const bySlug = db
    .prepare(
      `SELECT id, slug, name FROM workspaces
       WHERE lower(slug) = lower(?) AND status = 'active'
       LIMIT 1`,
    )
    .get(trimmed) as ResolvedWorkspace | undefined;
  if (bySlug) return bySlug;

  const byName = db
    .prepare(
      `SELECT id, slug, name FROM workspaces
       WHERE lower(name) = lower(?) AND status = 'active'`,
    )
    .all(trimmed) as unknown as ResolvedWorkspace[];
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `workspace name '${trimmed}' is ambiguous; use --workspace <id> (${byName
        .map((workspace) => workspace.id)
        .join(", ")})`,
    );
  }
  throw new Error(`unknown active workspace: ${trimmed}`);
}

function createAccess(
  db: DatabaseSync,
  workspace: ResolvedWorkspace,
  label?: string,
): WorkspaceAccessCreateResult {
  const created = createWorkspaceAccessToken(db, {
    workspaceId: workspace.id,
    label: label?.trim() || "Workspace browser access",
  });
  const loginPath = `/${encodeURIComponent(created.workspaceSlug)}/login`;
  return {
    plane: "cockpit",
    resource: "workspace-access",
    operation: "create",
    status: "created",
    workspaceId: created.workspaceId,
    workspaceSlug: created.workspaceSlug,
    tokenId: created.id,
    token: created.token,
    label: label?.trim() || "Workspace browser access",
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    loginPath,
    text:
      `Workspace access key created (shown once)\n` +
      `  workspace ${created.workspaceId} (${created.workspaceSlug})\n` +
      `  token     ${created.token}\n` +
      `  expires   ${created.expiresAt}\n` +
      `  login     ${loginPath}\n` +
      `  id        ${created.id}\n`,
  };
}

function listAccess(db: DatabaseSync, workspace: ResolvedWorkspace): WorkspaceAccessListResult {
  const tokens = listWorkspaceAccessTokens(db, workspace.id);
  const lines =
    tokens.length === 0
      ? `no workspace access tokens for ${workspace.id} (${workspace.slug}).\n`
      : tokens
          .map((token) => {
            const state = token.revokedAt ? "revoked" : token.usedAt ? "used" : "active";
            return `  ${token.id}  ${state}  expires ${token.expiresAt}${token.label ? `  ${token.label}` : ""}`;
          })
          .join("\n") + "\n";
  return {
    plane: "cockpit",
    resource: "workspace-access",
    operation: "list",
    status: "ok",
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    tokens,
    text: lines,
  };
}

function revokeAccess(
  db: DatabaseSync,
  workspace: ResolvedWorkspace,
  tokenId: string,
): WorkspaceAccessRevokeResult {
  const revoked = revokeWorkspaceAccessToken(db, {
    workspaceId: workspace.id,
    tokenId,
  });
  return {
    plane: "cockpit",
    resource: "workspace-access",
    operation: "revoke",
    status: revoked ? "revoked" : "not_found",
    workspaceId: workspace.id,
    tokenId,
    text: revoked
      ? `revoked workspace access token ${tokenId}\n`
      : `workspace access token ${tokenId} was not active\n`,
  };
}
