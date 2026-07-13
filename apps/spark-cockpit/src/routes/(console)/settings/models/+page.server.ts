import { fail, redirect } from "@sveltejs/kit";
import { getDictionary, localeCookieName, resolveRequestLocale } from "$lib/i18n";
import { formText } from "$lib/server/form-data";
import {
  cancelProviderOAuthForCockpit,
  getProviderOAuthFlowForCockpit,
  loadModelControlForCockpit,
  logoutProviderForCockpit,
  parseModelValue,
  respondProviderOAuthForCockpit,
  setDefaultModelForCockpit,
  setProviderApiKeyForCockpit,
  startProviderOAuthForCockpit,
} from "$lib/server/model-control";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url }) => {
  const control = await loadModelControlForCockpit();
  const flowId = url.searchParams.get("flow")?.trim() || null;
  let flow = null;
  let flowError: string | null = null;
  if (flowId && control.available) {
    try {
      flow = await getProviderOAuthFlowForCockpit(flowId);
    } catch (error) {
      flowError = errorMessage(error);
    }
  }
  return { control, flow, flowError };
};

export const actions: Actions = {
  setDefaultModel: async ({ cookies, request }) => {
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    try {
      await setDefaultModelForCockpit(parseModelValue(formText(form, "model")));
      return { intent: "setDefaultModel", success: true, message: copy.defaultUpdated };
    } catch (error) {
      return fail(400, actionError("setDefaultModel", error));
    }
  },

  saveApiKey: async ({ cookies, request }) => {
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    const providerName = formText(form, "providerName").trim();
    const apiKey = formText(form, "apiKey");
    try {
      await setProviderApiKeyForCockpit(providerName, apiKey);
      return { intent: "saveApiKey", success: true, message: copy.credentialSaved };
    } catch (error) {
      return fail(400, actionError("saveApiKey", error));
    }
  },

  logout: async ({ cookies, request }) => {
    const form = await request.formData();
    const copy = actionCopy(cookies.get(localeCookieName), request.headers.get("accept-language"));
    try {
      await logoutProviderForCockpit(formText(form, "providerName").trim());
      return { intent: "logout", success: true, message: copy.credentialRemoved };
    } catch (error) {
      return fail(400, actionError("logout", error));
    }
  },

  startOAuth: async ({ request, url }) => {
    const form = await request.formData();
    let flowId: string;
    try {
      const flow = await startProviderOAuthForCockpit(formText(form, "providerName").trim());
      flowId = flow.id;
    } catch (error) {
      return fail(400, actionError("startOAuth", error));
    }
    redirect(303, flowUrl(url, flowId));
  },

  respondOAuth: async ({ request, url }) => {
    const form = await request.formData();
    const flowId = formText(form, "flowId").trim();
    try {
      await respondProviderOAuthForCockpit(
        flowId,
        formText(form, "promptId").trim(),
        formText(form, "response"),
      );
    } catch (error) {
      return fail(400, actionError("respondOAuth", error));
    }
    redirect(303, flowUrl(url, flowId));
  },

  cancelOAuth: async ({ request }) => {
    const form = await request.formData();
    try {
      await cancelProviderOAuthForCockpit(formText(form, "flowId").trim());
    } catch (error) {
      return fail(400, actionError("cancelOAuth", error));
    }
    redirect(303, "/settings/models");
  },
};

function actionError(intent: string, error: unknown) {
  return { intent, success: false, message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flowUrl(url: URL, flowId: string): string {
  const next = new URL("/settings/models", url);
  next.searchParams.set("flow", flowId);
  return `${next.pathname}${next.search}`;
}

function actionCopy(cookieLocale: string | undefined, acceptLanguage: string | null) {
  const locale = resolveRequestLocale({ cookieLocale, acceptLanguage });
  return getDictionary(locale).modelSettings.actions;
}
