import { fail, redirect } from "@sveltejs/kit";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import {
  approveRuntimeDeviceAuthorization,
  denyRuntimeDeviceAuthorization,
  getRuntimeDeviceAuthorizationForApproval,
  RuntimeDeviceAuthorizationError,
} from "$lib/server/runtime-registration";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ cookies, locals, url }) => {
  const userCode = normalizeUserCode(url.searchParams.get("user_code"));
  const result = url.searchParams.get("result");
  if (!userCode) {
    return { authorization: null, result: null, userCode: "" };
  }

  const db = getDatabase();
  const currentUserId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);
  try {
    const authorization = getRuntimeDeviceAuthorizationForApproval(db, {
      userCode,
      currentUserId,
    });
    const safeResult =
      result === "approved" &&
      (authorization.status === "approved" || authorization.status === "consumed")
        ? "approved"
        : result === "denied" && authorization.status === "denied"
          ? "denied"
          : null;
    return {
      authorization,
      result: safeResult,
      userCode,
    };
  } catch (caught) {
    if (caught instanceof RuntimeDeviceAuthorizationError) {
      return {
        authorization: null,
        result: null,
        userCode,
        lookupError: caught.reasonCode,
      };
    }
    throw caught;
  }
};

export const actions: Actions = {
  approve: async ({ cookies, locals, request }) => {
    const userCode = normalizeUserCode(formText(await request.formData(), "userCode"));
    if (!userCode) return invalidCodeFailure();

    const db = getDatabase();
    const approvedByUserId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);
    try {
      approveRuntimeDeviceAuthorization(db, { userCode, approvedByUserId });
    } catch (caught) {
      if (caught instanceof RuntimeDeviceAuthorizationError) {
        return fail(400, {
          intent: "deviceAuthorization",
          message: caught.reasonCode,
          userCode,
        });
      }
      throw caught;
    }
    redirect(303, authorizationPath(userCode, "approved"));
  },

  deny: async ({ cookies, locals, request }) => {
    const userCode = normalizeUserCode(formText(await request.formData(), "userCode"));
    if (!userCode) return invalidCodeFailure();

    const db = getDatabase();
    const deniedByUserId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);
    try {
      denyRuntimeDeviceAuthorization(db, { userCode, deniedByUserId });
    } catch (caught) {
      if (caught instanceof RuntimeDeviceAuthorizationError) {
        return fail(400, {
          intent: "deviceAuthorization",
          message: caught.reasonCode,
          userCode,
        });
      }
      throw caught;
    }
    redirect(303, authorizationPath(userCode, "denied"));
  },
};

function invalidCodeFailure() {
  return fail(400, {
    intent: "deviceAuthorization",
    message: "invalid_grant",
    userCode: "",
  });
}

function normalizeUserCode(value: string | null): string {
  const normalized =
    value
      ?.trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "") ?? "";
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

function authorizationPath(userCode: string, result: "approved" | "denied"): string {
  const search = new URLSearchParams({ user_code: userCode, result });
  return `/daemon/authorize?${search.toString()}`;
}
