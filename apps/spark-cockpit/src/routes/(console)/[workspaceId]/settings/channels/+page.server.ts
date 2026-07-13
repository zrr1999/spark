import { fail, error as kitError, redirect } from "@sveltejs/kit";
import { createChannelExternalKey } from "@zendev-lab/spark-channels";
import { loadWorkspaceSettings } from "@zendev-lab/spark-server/cockpit-queries";
import {
  defaultCreateChannelScope,
  isValidCreateChannelScope,
  workspaceChannelListFromSessions,
  type CreateChannelAdapter,
  type CreateChannelFormValues,
} from "$lib/create-channel";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { formText } from "$lib/server/form-data";
import {
  channelAdapterCredentialsComplete,
  channelEditorValuesFromConfig,
  DEFAULT_INFOFLOW_ENDPOINT,
  loadChannelStatusForCockpit,
  loadChannelsConfigForCockpit,
  mergeAdapterCredentialsForCreate,
  saveChannelsConfigForCockpit,
  type CreateChannelCredentialPatch,
  type CockpitChannelEditorValues,
} from "$lib/server/channel-status";
import {
  archiveManagedSessionForCockpit,
  bindManagedSessionForCockpit,
  createManagedSessionForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import { getDatabase } from "$lib/server/db";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export type { CreateChannelFormValues } from "$lib/create-channel";

export const load: PageServerLoad = async ({ params }) => {
  const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
  if (!workspace) throw kitError(404, "Workspace not found.");

  const [channelStatus, loaded, sessionList] = await Promise.all([
    loadChannelStatusForCockpit(workspace.id),
    loadChannelsConfigForCockpit(workspace.id),
    listManagedSessionsForCockpit({
      scope: { kind: "workspace", workspaceId: workspace.id },
      workspaceId: workspace.id,
    }),
  ]);
  const editor = channelEditorValuesFromConfig(loaded.config);
  return {
    workspace,
    settingsPath: workspacePath(workspace, "/settings"),
    channelStatus,
    editor,
    channels: workspaceChannelListFromSessions(sessionList.sessions),
    sessionsAvailable: sessionList.available,
    defaults: {
      infoflowEndpoint: DEFAULT_INFOFLOW_ENDPOINT,
      adapter: defaultCreateAdapter(editor),
      scope: defaultCreateChannelScope(defaultCreateAdapter(editor)),
    },
  };
};

export const actions: Actions = {
  createChannel: async ({ cookies, request, params }) => {
    const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
    if (!workspace) throw kitError(404, "Workspace not found.");

    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).channelsSettings;
    const formData = await request.formData();
    const values = readCreateChannelForm(formData);
    const loaded = await loadChannelsConfigForCockpit(workspace.id);
    const previous = channelEditorValuesFromConfig(loaded.config);

    if (!isValidCreateChannelScope(values.adapter, values.scope)) {
      return fail(400, {
        intent: "createChannel",
        message: t.createInvalidScope,
        values,
      });
    }

    if (!values.externalId.trim()) {
      return fail(400, {
        intent: "createChannel",
        message: t.createExternalIdRequired,
        values,
      });
    }

    let externalKey: string;
    try {
      externalKey = createChannelExternalKey(values.adapter, values.scope, values.externalId);
    } catch (error) {
      return fail(400, {
        intent: "createChannel",
        message: error instanceof Error ? error.message : t.createFailed,
        values,
      });
    }

    const credentialError = await saveAdapterCredentials(workspace.id, values, previous, t);
    if (credentialError) {
      return fail(credentialError.status, {
        intent: "createChannel",
        message: credentialError.message,
        values,
      });
    }

    const title = values.title.trim() || `channel ${externalKey}`;
    let session;
    try {
      session = await createManagedSessionForCockpit({
        scope: { kind: "workspace", workspaceId: workspace.id },
        workspaceId: workspace.id,
        title,
      });
    } catch (error) {
      return fail(500, {
        intent: "createChannel",
        message: error instanceof Error ? error.message : t.createFailed,
        values,
      });
    }

    try {
      await bindManagedSessionForCockpit({
        sessionId: session.sessionId,
        externalKey,
      });
    } catch (error) {
      try {
        await archiveManagedSessionForCockpit(session.sessionId);
      } catch {
        // best-effort cleanup when bind fails after create
      }
      return fail(500, {
        intent: "createChannel",
        message: error instanceof Error ? error.message : t.createFailed,
        values,
      });
    }

    throw redirect(303, `/sessions/${session.sessionId}`);
  },

  saveCredentials: async ({ cookies, request, params }) => {
    const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
    if (!workspace) throw kitError(404, "Workspace not found.");

    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).channelsSettings;
    const formData = await request.formData();
    const values = readCreateChannelForm(formData);
    const loaded = await loadChannelsConfigForCockpit(workspace.id);
    const previous = channelEditorValuesFromConfig(loaded.config);

    const credentialError = await saveAdapterCredentials(workspace.id, values, previous, t);
    if (credentialError) {
      return fail(credentialError.status, {
        intent: "saveCredentials",
        message: credentialError.message,
        values,
      });
    }

    return {
      intent: "saveCredentials",
      message: t.saveCredentialsSuccess,
      values,
    };
  },
};

async function saveAdapterCredentials(
  workspaceId: string,
  values: CreateChannelFormValues,
  previous: CockpitChannelEditorValues,
  t: {
    saveFeishuRequired: string;
    saveInfoflowRequired: string;
    saveQqbotRequired: string;
    saveCredentialsFailed: string;
  },
): Promise<{ status: number; message: string } | null> {
  const merged = mergeAdapterCredentialsForCreate(previous, credentialPatchFromForm(values));
  if (values.adapter === "infoflow" && !merged.infoflowEndpoint.trim()) {
    merged.infoflowEndpoint = DEFAULT_INFOFLOW_ENDPOINT;
  }

  if (!channelAdapterCredentialsComplete(merged, values.adapter)) {
    return {
      status: 400,
      message:
        values.adapter === "feishu"
          ? t.saveFeishuRequired
          : values.adapter === "qqbot"
            ? t.saveQqbotRequired
            : t.saveInfoflowRequired,
    };
  }

  try {
    await saveChannelsConfigForCockpit(workspaceId, merged);
    return null;
  } catch (error) {
    return {
      status: 500,
      message: error instanceof Error ? error.message : t.saveCredentialsFailed,
    };
  }
}

function defaultCreateAdapter(editor: CockpitChannelEditorValues): CreateChannelAdapter {
  if (editor.infoflowEnabled) return "infoflow";
  if (editor.qqbotEnabled) return "qqbot";
  if (editor.feishuEnabled) return "feishu";
  return "infoflow";
}

function readCreateChannelForm(formData: FormData): CreateChannelFormValues {
  const adapter = parseAdapter(formText(formData, "adapter"));
  return {
    adapter,
    scope: formText(formData, "scope").trim() || defaultCreateChannelScope(adapter),
    externalId: formText(formData, "externalId"),
    title: formText(formData, "title"),
    feishuAppId: formText(formData, "feishuAppId"),
    feishuAppSecret: formText(formData, "feishuAppSecret"),
    infoflowEndpoint: formText(formData, "infoflowEndpoint"),
    infoflowAppKey: formText(formData, "infoflowAppKey"),
    infoflowAppAgentId: formText(formData, "infoflowAppAgentId"),
    infoflowAppSecret: formText(formData, "infoflowAppSecret"),
    qqbotAppId: formText(formData, "qqbotAppId"),
    qqbotClientSecret: formText(formData, "qqbotClientSecret"),
    qqbotSandbox: formData.get("qqbotSandbox") === "on",
  };
}

function credentialPatchFromForm(values: CreateChannelFormValues): CreateChannelCredentialPatch {
  switch (values.adapter) {
    case "feishu":
      return {
        adapter: "feishu",
        feishuAppId: values.feishuAppId,
        feishuAppSecret: values.feishuAppSecret,
      };
    case "infoflow":
      return {
        adapter: "infoflow",
        infoflowEndpoint: values.infoflowEndpoint,
        infoflowAppKey: values.infoflowAppKey,
        infoflowAppAgentId: values.infoflowAppAgentId,
        infoflowAppSecret: values.infoflowAppSecret,
      };
    case "qqbot":
      return {
        adapter: "qqbot",
        qqbotAppId: values.qqbotAppId,
        qqbotClientSecret: values.qqbotClientSecret,
        qqbotSandbox: values.qqbotSandbox,
      };
    default: {
      const _exhaustive: never = values.adapter;
      throw new Error(`unsupported create-channel adapter: ${String(_exhaustive)}`);
    }
  }
}

function parseAdapter(raw: string): CreateChannelAdapter {
  if (raw === "feishu" || raw === "infoflow" || raw === "qqbot") return raw;
  return "infoflow";
}
