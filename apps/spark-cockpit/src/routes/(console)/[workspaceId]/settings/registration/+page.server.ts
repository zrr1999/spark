import { fail, error as kitError } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import {
  buildDaemonLoginCommand,
  buildDaemonWorkspaceRegistrationCommand,
  isInsecureRemoteServerOrigin,
  isLoopbackServerOrigin,
} from "$lib/server/daemon-registration-commands";
import { formText } from "$lib/server/form-data";
import {
  createRuntimeEnrollmentToken,
  revokeRuntimeEnrollmentToken,
} from "$lib/server/runtime-registration";
import { loadWorkspaceRegistrationPage } from "@zendev-lab/spark-server/cockpit-queries";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url }) => {
  const page = loadWorkspaceRegistrationPage(getDatabase(), params.workspaceId);
  if (!page) throw kitError(404, "Workspace not found.");
  return {
    ...page,
    backSettingsPath: workspacePath(page.workspace, "/settings"),
    serverOrigin: url.origin,
    deviceLoginCommand: buildDaemonLoginCommand(url.origin),
    workspaceRegisterCommand: buildDaemonWorkspaceRegistrationCommand({
      serverOrigin: url.origin,
      displayName: page.workspace.name,
      workspaceName: page.workspace.name,
      workspaceSlug: page.workspace.slug,
    }),
    loopbackServerOrigin: isLoopbackServerOrigin(url),
    insecureRemoteServerOrigin: isInsecureRemoteServerOrigin(url),
  };
};

export const actions: Actions = {
  createEnrollmentToken: async ({ cookies, locals, params, request, url }) => {
    const messages = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).settings;
    const db = getDatabase();
    const page = loadWorkspaceRegistrationPage(db, params.workspaceId);
    if (!page) throw kitError(404, "Workspace not found.");
    const { workspace } = page;
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

function buildEnrollCommand(serverOrigin: string, refreshToken: string, workspaceName: string) {
  return buildDaemonWorkspaceRegistrationCommand({
    serverOrigin,
    displayName: workspaceName,
    registrationToken: refreshToken,
  });
}
