import { fail, redirect, type Cookies } from "@sveltejs/kit";
import { asciiSlug } from "@zendev-lab/navia-system";
import type { DatabaseSync } from "node:sqlite";
import { getRequestDictionary, localeCookieName, type AppMessages } from "$lib/i18n";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { createWorkspaceWithOwnerBinding } from "$lib/server/projection-services";
import {
  bindRuntimeRefreshTokenToWorkspace,
  createRuntimeEnrollmentToken,
} from "$lib/server/runtime-registration";
import {
  builtinFreshWorkspaceProfile,
  loadWorkspaceProfileFromGitHubUrl,
  resolveWorkspaceProfileInputs,
} from "$lib/server/workspace-profiles";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

const pendingWorkspaceSetupCookie = "navia_pending_workspace_setup";

type WorkspaceSetupProfileSource = "builtin:fresh" | "git";

interface PendingWorkspaceSetup {
  profileSource: WorkspaceSetupProfileSource;
  profileUrl: string;
  name: string;
  slug: string;
  description: string | null;
  enrollmentTokenId?: string;
}

interface RuntimeWorkspaceBindingView {
  id: string;
  runtimeId: string;
  localWorkspaceKey: string;
  displayName: string;
  status: "available" | "indexing" | "degraded" | "unavailable" | "archived";
  lastSnapshotAt: string | null;
  updatedAt: string;
  runtimeName: string;
  runtimeStatus: string;
}

export const load: PageServerLoad = ({ cookies, url }) => {
  const db = getDatabase();
  const forceWorkspaceCreate = isWorkspaceCreateFlow(url);
  const workspaces = db
    .prepare(
      `SELECT w.id,
              w.slug,
              w.name,
              w.description,
              w.status,
              w.created_at AS createdAt,
              w.updated_at AS updatedAt,
              COUNT(DISTINCT p.id) AS projectCount,
              COUNT(DISTINCT CASE WHEN ii.status = 'pending' THEN ii.id END) AS pendingInboxCount,
              COUNT(DISTINCT a.id) AS artifactCount,
              rb.display_name AS bindingName,
              rb.status AS bindingStatus,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus,
              wps.profile_name AS profileName,
              wps.source_kind AS profileSourceKind
       FROM workspaces w
       LEFT JOIN projects p ON p.workspace_id = w.id
       LEFT JOIN inbox_items ii ON ii.workspace_id = w.id
       LEFT JOIN artifacts a ON a.workspace_id = w.id
       LEFT JOIN workspace_owner_bindings wob
         ON wob.workspace_id = w.id
        AND wob.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN workspace_profile_sources wps ON wps.workspace_id = w.id
       WHERE w.status = 'active'
       GROUP BY w.id
       ORDER BY w.updated_at DESC, w.created_at DESC`,
    )
    .all() as Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    projectCount: number;
    pendingInboxCount: number;
    artifactCount: number;
    bindingName: string | null;
    bindingStatus: string | null;
    runtimeName: string | null;
    runtimeStatus: string | null;
    profileName: string | null;
    profileSourceKind: string | null;
  }>;

  if (workspaces.length > 0 && !forceWorkspaceCreate) {
    redirect(303, workspacePath(workspaces[0]));
  }

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
       ORDER BY rb.updated_at DESC`,
    )
    .all() as unknown as RuntimeWorkspaceBindingView[];

  const ownerBindings = db
    .prepare(
      `SELECT wob.id,
              wob.workspace_id AS workspaceId,
              wob.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              wob.started_at AS startedAt,
              w.name AS workspaceName,
              rb.display_name AS bindingName,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM workspace_owner_bindings wob
       JOIN workspaces w ON w.id = wob.workspace_id
       JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE wob.ended_at IS NULL
       ORDER BY wob.started_at DESC`,
    )
    .all() as Array<{
    id: string;
    workspaceId: string;
    runtimeWorkspaceBindingId: string;
    startedAt: string;
    workspaceName: string;
    bindingName: string;
    runtimeName: string;
    runtimeStatus: string;
  }>;

  const pendingWorkspaceSetup = readPendingWorkspaceSetup(cookies);
  const targetRunnerBinding = pendingWorkspaceSetup
    ? resolvePendingWorkspaceBinding(db, pendingWorkspaceSetup)
    : null;

  return {
    serverOrigin: url.origin,
    workspaces: forceWorkspaceCreate ? [] : workspaces,
    runnerBindings,
    ownerBindings,
    pendingWorkspaceSetup,
    targetRunnerBinding,
  };
};

function isWorkspaceCreateFlow(url: URL): boolean {
  return (
    url.searchParams.get("create") === "workspace" ||
    url.searchParams.has("/createEnrollmentToken") ||
    url.searchParams.has("/createWorkspace")
  );
}

export const actions: Actions = {
  createEnrollmentToken: async ({ cookies, locals, request, url }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).home.formMessages;
    const db = getDatabase();
    const userId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);

    const formData = await request.formData();
    let workspaceSetup: PendingWorkspaceSetup;
    try {
      workspaceSetup = resolvePendingWorkspaceSetup(formData);
    } catch (error) {
      return fail(400, {
        intent: "workspaceRegistration",
        message: workspaceSetupErrorMessage(error, t),
        profileSetup: readWorkspaceSetupFormForResponse(formData),
      });
    }

    const label = `${t.registrationLabelPrefix}: ${workspaceSetup.name}`;
    const token = createRuntimeEnrollmentToken(db, {
      label,
      createdByUserId: userId,
      workspaceName: workspaceSetup.name,
      workspaceSlug: workspaceSetup.slug,
    });
    workspaceSetup = { ...workspaceSetup, enrollmentTokenId: token.id };
    setPendingWorkspaceSetup(cookies, workspaceSetup);

    return {
      intent: "workspaceRegistration",
      message: t.commandCreated,
      profileSetup: workspaceSetup,
      enrollmentTokenId: token.id,
      enrollmentToken: token.refreshToken,
      enrollmentExpiresAt: token.expiresAt,
      enrollCommand: buildEnrollCommand(url.origin, token.refreshToken, workspaceSetup),
    };
  },

  createWorkspace: async ({ cookies, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).home.formMessages;
    const formData = await request.formData();
    const pendingWorkspaceSetup = readPendingWorkspaceSetup(cookies);
    let workspaceSetup: PendingWorkspaceSetup;
    try {
      workspaceSetup = readWorkspaceSetupForm(formData, pendingWorkspaceSetup ?? undefined);
    } catch (error) {
      return fail(400, {
        intent: "workspace",
        message: workspaceSetupErrorMessage(error, t),
      });
    }
    const description = workspaceSetup.description;
    const targetRunnerBinding = resolvePendingWorkspaceBinding(getDatabase(), workspaceSetup);
    const runtimeWorkspaceBindingId = targetRunnerBinding?.id ?? null;

    if (!runtimeWorkspaceBindingId) {
      return fail(400, {
        intent: "workspace",
        message: t.registerWorkspaceFirst,
      });
    }

    let profile;
    try {
      if (workspaceSetup.profileSource === "git") {
        if (!workspaceSetup.profileUrl) {
          return fail(400, {
            intent: "workspace",
            message: t.githubProfileRequired,
          });
        }
        profile = loadWorkspaceProfileFromGitHubUrl(workspaceSetup.profileUrl);
      } else if (workspaceSetup.profileSource === "builtin:fresh") {
        profile = builtinFreshWorkspaceProfile();
      } else {
        return fail(400, {
          intent: "workspace",
          message: t.unsupportedProfileSource,
        });
      }
    } catch (error) {
      return fail(400, {
        intent: "workspace",
        message: error instanceof Error ? error.message : t.loadProfileFailed,
      });
    }

    let resolvedInputs;
    try {
      resolvedInputs = resolveWorkspaceProfileInputs(profile, {
        workspaceName: workspaceSetup.name,
        workspaceSlug: workspaceSetup.slug,
      });
    } catch (error) {
      return fail(400, {
        intent: "workspace",
        message: workspaceSetupErrorMessage(error, t),
      });
    }

    const name = resolvedInputs.workspaceName;
    const slug = slugify(resolvedInputs.workspaceSlug);
    if (!name || !slug) {
      return fail(400, {
        intent: "workspace",
        message: t.workspaceRequired,
      });
    }

    try {
      const workspace = createWorkspaceWithOwnerBinding(getDatabase(), {
        name,
        slug,
        description,
        settings: {
          ...profile.settings,
          profileInputs: resolvedInputs.values,
        },
        profileSource: {
          sourceKind: profile.source.kind,
          profileId: profile.profile.id,
          profileName: profile.profile.name,
          schemaVersion: profile.schemaVersion,
          repoUrl: profile.source.repoUrl,
          sourcePath: profile.source.path,
          commitHash: profile.source.commitHash,
        },
        agentSpecs: profile.agents,
        resources: profile.resources,
        runtimeWorkspaceBindingId,
      });
      if (workspaceSetup.enrollmentTokenId) {
        bindRuntimeRefreshTokenToWorkspace(getDatabase(), {
          tokenId: workspaceSetup.enrollmentTokenId,
          workspaceId: workspace.id,
        });
      }
      cookies.delete(pendingWorkspaceSetupCookie, { path: "/" });
    } catch (error) {
      return fail(400, {
        intent: "workspace",
        message: error instanceof Error ? error.message : t.createWorkspaceFailed,
      });
    }

    redirect(303, `/${slug}`);
  },
};

function workspaceSetupErrorMessage(error: unknown, messages: AppMessages["home"]["formMessages"]) {
  const message = error instanceof Error ? error.message : "";
  if (message === "GitHub profile URL is required.") {
    return messages.githubProfileRequired;
  }
  if (message === "Unsupported workspace profile source.") {
    return messages.unsupportedProfileSource;
  }

  return message || messages.profileInvalid;
}

function buildEnrollCommand(
  serverOrigin: string,
  refreshToken: string,
  setup: PendingWorkspaceSetup,
) {
  return [
    "spark-daemon workspace register",
    `--server-url ${shellQuote(serverOrigin)}`,
    `--token ${shellQuote(refreshToken)}`,
    `--name ${shellQuote(setup.name)}`,
  ].join(" ");
}

function resolvePendingWorkspaceSetup(formData: FormData): PendingWorkspaceSetup {
  const setup = readWorkspaceSetupForm(formData);
  let profile;
  if (setup.profileSource === "git") {
    if (!setup.profileUrl) {
      throw new Error("GitHub profile URL is required.");
    }
    profile = loadWorkspaceProfileFromGitHubUrl(setup.profileUrl);
  } else {
    profile = builtinFreshWorkspaceProfile();
  }

  const resolvedInputs = resolveWorkspaceProfileInputs(profile, {
    workspaceName: setup.name,
    workspaceSlug: setup.slug,
  });

  return {
    ...setup,
    name: resolvedInputs.workspaceName,
    slug: resolvedInputs.workspaceSlug,
  };
}

function readWorkspaceSetupForm(
  formData: FormData,
  fallback?: PendingWorkspaceSetup,
): PendingWorkspaceSetup {
  const rawProfileSource =
    readFormString(formData, "profileSource") || fallback?.profileSource || "git";
  if (rawProfileSource !== "git" && rawProfileSource !== "builtin:fresh") {
    throw new Error("Unsupported workspace profile source.");
  }

  return {
    profileSource: rawProfileSource,
    profileUrl: readFormString(formData, "profileUrl") || fallback?.profileUrl || "",
    name:
      readFormString(formData, "name") ||
      readFormString(formData, "workspaceName") ||
      fallback?.name ||
      "",
    slug:
      readFormString(formData, "slug") ||
      readFormString(formData, "workspaceSlug") ||
      fallback?.slug ||
      "",
    description: readOptionalFormString(formData, "description", fallback?.description ?? null),
    enrollmentTokenId: fallback?.enrollmentTokenId,
  };
}

function readWorkspaceSetupFormForResponse(formData: FormData): PendingWorkspaceSetup {
  try {
    return readWorkspaceSetupForm(formData);
  } catch {
    return {
      profileSource: "git",
      profileUrl: readFormString(formData, "profileUrl"),
      name: readFormString(formData, "name") || readFormString(formData, "workspaceName"),
      slug: readFormString(formData, "slug") || readFormString(formData, "workspaceSlug"),
      description: readOptionalFormString(formData, "description", null),
    };
  }
}

function readPendingWorkspaceSetup(cookies: Cookies): PendingWorkspaceSetup | null {
  const rawValue = cookies.get(pendingWorkspaceSetupCookie);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<PendingWorkspaceSetup>;
    if (
      (parsed.profileSource === "git" || parsed.profileSource === "builtin:fresh") &&
      typeof parsed.profileUrl === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.slug === "string"
    ) {
      return {
        profileSource: parsed.profileSource,
        profileUrl: parsed.profileUrl,
        name: parsed.name,
        slug: parsed.slug,
        description: typeof parsed.description === "string" ? parsed.description : null,
        enrollmentTokenId:
          typeof parsed.enrollmentTokenId === "string" ? parsed.enrollmentTokenId : undefined,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function setPendingWorkspaceSetup(cookies: Cookies, setup: PendingWorkspaceSetup): void {
  cookies.set(pendingWorkspaceSetupCookie, JSON.stringify(setup), {
    httpOnly: true,
    maxAge: 60 * 60 * 24,
    path: "/",
    sameSite: "lax",
  });
}

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalFormString(
  formData: FormData,
  key: string,
  fallback: string | null,
): string | null {
  const value = readFormString(formData, key);
  return value || fallback;
}

function resolvePendingWorkspaceBinding(
  db: DatabaseSync,
  setup: PendingWorkspaceSetup,
): RuntimeWorkspaceBindingView | null {
  if (setup.enrollmentTokenId) {
    const runtimeId = readEnrollmentRuntimeId(db, setup.enrollmentTokenId);
    if (!runtimeId) {
      return null;
    }

    return (
      findMatchingWorkspaceBinding(db, setup, runtimeId) ??
      findOnlyAvailableWorkspaceBindingForRuntime(db, runtimeId)
    );
  }

  return findMatchingWorkspaceBinding(db, setup, null);
}

function readEnrollmentRuntimeId(db: DatabaseSync, enrollmentTokenId: string): string | null {
  const row = db
    .prepare(
      `SELECT created_runtime_id AS createdRuntimeId
       FROM runtime_enrollment_tokens
       WHERE id = ?
       LIMIT 1`,
    )
    .get(enrollmentTokenId) as { createdRuntimeId: string | null } | undefined;
  return row?.createdRuntimeId ?? null;
}

function findMatchingWorkspaceBinding(
  db: DatabaseSync,
  setup: PendingWorkspaceSetup,
  runtimeId: string | null,
): RuntimeWorkspaceBindingView | null {
  const runtimeFilter = runtimeId ? "AND rb.runtime_id = ?" : "";
  const args = runtimeId
    ? [setup.name, setup.slug, runtimeId, setup.name, setup.slug]
    : [setup.name, setup.slug, setup.name, setup.slug];
  const row = db
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
       WHERE rb.status = 'available'
         AND rc.status = 'online'
         AND (rb.display_name = ? OR rb.local_workspace_key = ?)
         ${runtimeFilter}
       ORDER BY CASE
                  WHEN rb.display_name = ? THEN 0
                  WHEN rb.local_workspace_key = ? THEN 1
                  ELSE 2
                END,
                rb.updated_at DESC
       LIMIT 1`,
    )
    .get(...args) as RuntimeWorkspaceBindingView | undefined;
  return row ?? null;
}

function findOnlyAvailableWorkspaceBindingForRuntime(
  db: DatabaseSync,
  runtimeId: string,
): RuntimeWorkspaceBindingView | null {
  const rows = db
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
       WHERE rb.status = 'available'
         AND rc.status = 'online'
         AND rb.runtime_id = ?
       ORDER BY rb.updated_at DESC
       LIMIT 2`,
    )
    .all(runtimeId) as unknown as RuntimeWorkspaceBindingView[];
  return rows.length === 1 ? rows[0] : null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slugify(value: string) {
  return asciiSlug(value, { maxLength: 48 });
}
