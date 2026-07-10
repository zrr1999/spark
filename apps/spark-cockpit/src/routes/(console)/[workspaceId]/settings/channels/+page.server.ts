import { fail, error as kitError } from "@sveltejs/kit";
import { loadWorkspaceSettings } from "@zendev-lab/spark-server/cockpit-queries";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { formText } from "$lib/server/form-data";
import {
  channelEditorCredentialsComplete,
  channelEditorValuesFromConfig,
  DEFAULT_INFOFLOW_ENDPOINT,
  loadChannelStatusForCockpit,
  loadChannelsConfigForCockpit,
  saveChannelsConfigForCockpit,
  type CockpitChannelEditorValues,
} from "$lib/server/channel-status";
import { getDatabase } from "$lib/server/db";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
  if (!workspace) throw kitError(404, "Workspace not found.");

  const [channelStatus, loaded] = await Promise.all([
    loadChannelStatusForCockpit(workspace.id),
    loadChannelsConfigForCockpit(workspace.id),
  ]);
  return {
    workspace,
    settingsPath: workspacePath(workspace, "/settings"),
    channelStatus,
    editor: channelEditorValuesFromConfig(loaded.config),
    defaults: {
      infoflowEndpoint: DEFAULT_INFOFLOW_ENDPOINT,
    },
  };
};

export const actions: Actions = {
  save: async ({ cookies, request, params }) => {
    const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
    if (!workspace) throw kitError(404, "Workspace not found.");

    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).channelsSettings;
    const formData = await request.formData();
    const values = readEditorValues(formData);

    if (!values.feishuEnabled && !values.infoflowEnabled) {
      return fail(400, {
        intent: "save",
        message: t.saveNeedAdapter,
        values,
      });
    }

    if (values.infoflowEnabled && !values.infoflowEndpoint.trim()) {
      values.infoflowEndpoint = DEFAULT_INFOFLOW_ENDPOINT;
    }

    if (!channelEditorCredentialsComplete(values)) {
      return fail(400, {
        intent: "save",
        message: values.feishuEnabled ? t.saveFeishuRequired : t.saveInfoflowRequired,
        values,
      });
    }

    try {
      const saved = await saveChannelsConfigForCockpit(workspace.id, values);
      return {
        intent: "save",
        message: t.saveSuccess,
        values: channelEditorValuesFromConfig(saved.config),
        configPath: saved.path,
      };
    } catch (error) {
      return fail(500, {
        intent: "save",
        message: error instanceof Error ? error.message : t.saveFailed,
        values,
      });
    }
  },
};

function readEditorValues(formData: FormData): CockpitChannelEditorValues {
  const routeAdapterRaw = formText(formData, "routeAdapter").trim();
  const onUnboundRaw = formText(formData, "onUnbound").trim();
  return {
    feishuEnabled: formData.get("feishuEnabled") === "on",
    feishuAppId: formText(formData, "feishuAppId"),
    feishuAppSecret: formText(formData, "feishuAppSecret"),
    feishuAppSecretSet: formData.get("feishuAppSecretSet") === "1",
    infoflowEnabled: formData.get("infoflowEnabled") === "on",
    infoflowEndpoint: formText(formData, "infoflowEndpoint"),
    infoflowAppKey: formText(formData, "infoflowAppKey"),
    infoflowAppAgentId: formText(formData, "infoflowAppAgentId"),
    infoflowAppSecret: formText(formData, "infoflowAppSecret"),
    infoflowAppSecretSet: formData.get("infoflowAppSecretSet") === "1",
    infoflowAllowedUserIds: formText(formData, "infoflowAllowedUserIds"),
    infoflowGroupPolicy: parseGroupPolicy(formText(formData, "infoflowGroupPolicy")),
    infoflowAllowedGroupIds: formText(formData, "infoflowAllowedGroupIds"),
    routeName: formText(formData, "routeName") || "ops",
    routeAdapter: routeAdapterRaw === "infoflow" ? "infoflow" : "feishu",
    routeRecipient: formText(formData, "routeRecipient"),
    ingressEnabled: formData.get("ingressEnabled") === "on",
    onUnbound: onUnboundRaw === "reject" ? "reject" : "create",
  };
}

function parseGroupPolicy(raw: string): CockpitChannelEditorValues["infoflowGroupPolicy"] {
  if (raw === "allowlist" || raw === "open" || raw === "disabled") return raw;
  return "disabled";
}
