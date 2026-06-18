import { fail, redirect } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import {
  createRuntimeEnrollmentToken,
  listRuntimeEnrollmentTokens,
  revokeRuntimeEnrollmentToken,
} from "$lib/server/runtime-registration";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url }) => {
  const db = getDatabase();
  const workspace = loadWorkspaceSettings(db, params.workspaceId);

  const runnerConnections = db
    .prepare(
      `SELECT DISTINCT rc.id,
              rc.installation_id AS installationId,
              rc.name,
              rc.status,
              rc.protocol_version AS protocolVersion,
              rc.last_heartbeat_at AS lastHeartbeatAt,
              rc.updated_at AS updatedAt
       FROM runtime_connections rc
       JOIN runtime_workspace_bindings rb ON rb.runtime_id = rc.id
       JOIN workspace_owner_bindings wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.ended_at IS NULL
       WHERE wob.workspace_id = ?
       ORDER BY rc.updated_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    installationId: string | null;
    name: string;
    status: "online" | "offline" | "draining" | "disabled";
    protocolVersion: string | null;
    lastHeartbeatAt: string | null;
    updatedAt: string;
  }>;

  const runnerBindings = db
    .prepare(
      `SELECT rb.id,
              rb.runtime_id AS runtimeId,
              rb.local_workspace_key AS localWorkspaceKey,
              rb.display_name AS displayName,
              rb.status,
              rb.last_snapshot_at AS lastSnapshotAt,
              rb.updated_at AS updatedAt,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM runtime_workspace_bindings rb
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       JOIN workspace_owner_bindings wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.ended_at IS NULL
       WHERE wob.workspace_id = ?
       ORDER BY rb.updated_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    runtimeId: string;
    localWorkspaceKey: string;
    displayName: string;
    status: "available" | "indexing" | "degraded" | "unavailable" | "archived";
    lastSnapshotAt: string | null;
    updatedAt: string;
    runtimeName: string;
    runtimeStatus: string;
  }>;

  const connectedSessions = db
    .prepare("SELECT COUNT(*) AS count FROM runtime_sessions WHERE status = 'connected'")
    .get() as { count: number };

  return {
    workspace,
    serverOrigin: url.origin,
    runnerConnections,
    runnerBindings,
    enrollmentTokens: listRuntimeEnrollmentTokens(db, {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
    }),
    connectedSessionCount: connectedSessions.count,
  };
};

export const actions: Actions = {
  updateWorkspace: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).settings.formMessages;
    const db = getDatabase();
    const workspace = loadWorkspaceSettings(db, params.workspaceId);
    ensureCurrentOwnerSession(db, cookies, locals.sessionToken);

    const formData = await request.formData();
    const name = formText(formData, "name").trim();
    const slug = slugify(formText(formData, "slug", name));
    const descriptionValue = formText(formData, "description").trim();
    const description = descriptionValue || null;

    if (!name || !slug) {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.workspaceRequired,
      });
    }

    const duplicate = db
      .prepare(
        `SELECT id
         FROM workspaces
         WHERE slug = ?
           AND id != ?
           AND status = 'active'
         LIMIT 1`,
      )
      .get(slug, workspace.id) as { id: string } | undefined;

    if (duplicate) {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.slugUsed,
      });
    }

    db.prepare(
      `UPDATE workspaces
       SET name = ?,
           slug = ?,
           description = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(name, slug, description, new Date().toISOString(), workspace.id);

    if (slug !== workspace.slug) {
      redirect(303, workspacePath({ slug }, "/settings"));
    }

    return {
      intent: "workspaceSettings",
      message: t.saved,
    };
  },

  createEnrollmentToken: async ({ cookies, locals, params, request, url }) => {
    const messages = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).settings;
    const db = getDatabase();
    const workspace = loadWorkspaceSettings(db, params.workspaceId);
    const userId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);

    const formData = await request.formData();
    const label = formText(formData, "label").trim() || messages.enrollment.labelPlaceholder;
    const token = createRuntimeEnrollmentToken(db, {
      label,
      createdByUserId: userId,
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      workspaceId: workspace.id,
    });

    return {
      intent: "runnerEnrollment",
      message: messages.formMessages.commandCreated,
      enrollmentTokenId: token.id,
      enrollmentToken: token.refreshToken,
      enrollmentExpiresAt: token.expiresAt,
      enrollCommand: buildEnrollCommand(url.origin, token.refreshToken, workspace.name),
    };
  },

  revokeEnrollmentToken: async ({ cookies, locals, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).settings.formMessages;
    const db = getDatabase();
    ensureCurrentOwnerSession(db, cookies, locals.sessionToken);

    const formData = await request.formData();
    const tokenId = formText(formData, "tokenId").trim();
    if (!tokenId) {
      return fail(400, {
        intent: "runnerEnrollment",
        message: t.tokenIdRequired,
      });
    }

    const revoked = revokeRuntimeEnrollmentToken(db, { id: tokenId });
    return {
      intent: "runnerEnrollment",
      message: revoked ? t.tokenRevoked : t.tokenNotActive,
    };
  },
};

function loadWorkspaceSettings(db: ReturnType<typeof getDatabase>, workspaceId: string) {
  const routeWorkspace = requireWorkspaceByRouteId(db, workspaceId);
  return db
    .prepare(
      `SELECT id,
              slug,
              name,
              description,
              status,
              settings_json AS settingsJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM workspaces
       WHERE id = ?
       LIMIT 1`,
    )
    .get(routeWorkspace.id) as {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: "active" | "archived";
    settingsJson: string;
    createdAt: string;
    updatedAt: string;
  };
}

function buildEnrollCommand(serverOrigin: string, refreshToken: string, workspaceName: string) {
  return [
    "navia ws register",
    `--server-url ${shellQuote(serverOrigin)}`,
    `--token ${shellQuote(refreshToken)}`,
    `--name ${shellQuote(workspaceName)}`,
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
