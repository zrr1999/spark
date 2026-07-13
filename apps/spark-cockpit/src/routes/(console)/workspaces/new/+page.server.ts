import { fail, redirect, type Cookies } from "@sveltejs/kit";
import {
  isReservedWorkbenchPathSegment,
  loadWorkbenchHome,
  resolvePendingWorkspaceBinding,
} from "@zendev-lab/spark-server/cockpit-queries";
import { getRequestDictionary, localeCookieName, type AppMessages } from "$lib/i18n";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import {
  buildDaemonLoginCommand,
  buildDaemonWorkspaceRegistrationCommand,
  isInsecureRemoteServerOrigin,
  isLoopbackServerOrigin,
} from "$lib/server/daemon-registration-commands";
import { createWorkspaceWithOwnerBinding } from "$lib/server/projection-services";
import {
  bindRuntimeRefreshTokenToWorkspace,
  createRuntimeEnrollmentToken,
} from "$lib/server/runtime-registration";
import { slugifyWorkspaceIdentifier } from "$lib/slugify";
import {
  builtinFreshWorkspaceProfile,
  loadWorkspaceProfileFromGitHubUrl,
  resolveWorkspaceProfileInputs,
} from "$lib/server/workspace-profiles";
import type { Actions, PageServerLoad } from "./$types";

const pendingWorkspaceSetupCookie = "spark_cockpit_pending_workspace_setup";

type WorkspaceSetupProfileSource = "builtin:fresh" | "git";

interface PendingWorkspaceSetup {
  profileSource: WorkspaceSetupProfileSource;
  profileUrl: string;
  name: string;
  slug: string;
  description: string | null;
  enrollmentTokenId?: string;
}

export const load: PageServerLoad = ({ cookies, url }) => {
  const pendingWorkspaceSetup = readPendingWorkspaceSetup(cookies);
  const page = loadWorkbenchHome(getDatabase(), {
    forceWorkspaceCreate: true,
    pendingWorkspaceSetup,
  });
  return {
    serverOrigin: url.origin,
    loopbackServerOrigin: isLoopbackServerOrigin(url),
    insecureRemoteServerOrigin: isInsecureRemoteServerOrigin(url),
    workspaces: page.workspaces,
    runnerBindings: page.runnerBindings,
    ownerBindings: page.ownerBindings,
    pendingWorkspaceSetup,
    pendingDeviceRegistrationCommand:
      pendingWorkspaceSetup && !pendingWorkspaceSetup.enrollmentTokenId
        ? {
            registrationMode: "device" as const,
            enrollCommand: buildDeviceRegistrationCommand(url.origin, pendingWorkspaceSetup),
            enrollmentExpiresAt: null,
            profileSetup: pendingWorkspaceSetup,
          }
        : null,
    targetRunnerBinding: page.targetRunnerBinding,
  };
};

export const actions: Actions = {
  prepareRegistration: async ({ cookies, locals, request, url }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).home.formMessages;
    const db = getDatabase();
    const userId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);

    const formData = await request.formData();
    const registrationMethod = readFormString(formData, "registrationMethod") || "device";
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

    if (registrationMethod === "token") {
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
        registrationMode: "token",
        message: t.commandCreated,
        profileSetup: workspaceSetup,
        enrollmentTokenId: token.id,
        enrollmentToken: token.refreshToken,
        enrollmentExpiresAt: token.expiresAt,
        enrollCommand: buildEnrollCommand(url.origin, token.refreshToken, workspaceSetup),
      };
    }

    workspaceSetup = {
      profileSource: workspaceSetup.profileSource,
      profileUrl: workspaceSetup.profileUrl,
      name: workspaceSetup.name,
      slug: workspaceSetup.slug,
      description: workspaceSetup.description,
    };
    setPendingWorkspaceSetup(cookies, workspaceSetup);
    return {
      intent: "workspaceRegistration",
      registrationMode: "device",
      message: t.commandCreated,
      profileSetup: workspaceSetup,
      enrollmentExpiresAt: null,
      enrollCommand: buildDeviceRegistrationCommand(url.origin, workspaceSetup),
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
    const slug = slugifyWorkspaceIdentifier(resolvedInputs.workspaceSlug);
    if (!name || !slug) {
      return fail(400, {
        intent: "workspace",
        message: t.workspaceRequired,
      });
    }
    if (isReservedWorkbenchPathSegment(slug)) {
      return fail(400, {
        intent: "workspace",
        message: t.slugReserved,
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

    redirect(303, "/sessions");
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
  return buildDaemonWorkspaceRegistrationCommand({
    serverOrigin,
    displayName: setup.name,
    registrationToken: refreshToken,
  });
}

function buildDeviceRegistrationCommand(serverOrigin: string, setup: PendingWorkspaceSetup) {
  return [
    buildDaemonLoginCommand(serverOrigin),
    buildDaemonWorkspaceRegistrationCommand({
      serverOrigin,
      displayName: setup.name,
      workspaceName: setup.name,
      workspaceSlug: setup.slug,
    }),
  ].join("\n");
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
