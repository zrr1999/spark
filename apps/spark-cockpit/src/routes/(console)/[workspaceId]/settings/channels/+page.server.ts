import { error as kitError, fail } from "@sveltejs/kit";
import { loadWorkspaceSettings } from "@zendev-lab/spark-coordination/cockpit-queries";
import {
  isMessagePlatformAdapter,
  workspaceMessagePlatformConnections,
  type MessagePlatformAdapter,
  type MessagePlatformFormValues,
} from "$lib/message-platform";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { formText } from "$lib/server/form-data";
import {
  channelAdapterCredentialsComplete,
  channelEditorValuesFromConfig,
  DEFAULT_INFOFLOW_ENDPOINT,
  loadChannelStatusForCockpit,
  loadChannelsConfigForCockpit,
  mergeMessagePlatformCredentials,
  saveChannelsConfigForCockpit,
  type CockpitChannelEditorValues,
  type MessagePlatformCredentialPatch,
} from "$lib/server/channel-status";
import { getDatabase } from "$lib/server/db";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export type { MessagePlatformFormValues } from "$lib/message-platform";

export const load: PageServerLoad = async ({ params }) => {
  const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
  if (!workspace) throw kitError(404, "Workspace not found.");

  const [channelStatus, loaded] = await Promise.all([
    loadChannelStatusForCockpit(workspace.id),
    loadChannelsConfigForCockpit(workspace.id),
  ]);
  const editor = channelEditorValuesFromConfig(loaded.config);
  return {
    workspace,
    settingsPath: workspacePath(workspace, "/settings"),
    channelStatus,
    editor,
    platforms: workspaceMessagePlatformConnections(editor, channelStatus.adapters),
    defaults: {
      infoflowEndpoint: DEFAULT_INFOFLOW_ENDPOINT,
      adapter: defaultMessagePlatformAdapter(editor),
    },
  };
};

export const actions: Actions = {
  savePlatform: async ({ cookies, request, params }) => {
    const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
    if (!workspace) throw kitError(404, "Workspace not found.");

    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).channelsSettings;
    const formData = await request.formData();
    const values = readMessagePlatformForm(formData);
    const loaded = await loadChannelsConfigForCockpit(workspace.id);
    const previous = channelEditorValuesFromConfig(loaded.config);

    const credentialError = await saveMessagePlatformCredentials(workspace.id, values, previous, t);
    if (credentialError) {
      return fail(credentialError.status, {
        intent: "savePlatform",
        message: credentialError.message,
        values,
      });
    }

    return {
      intent: "savePlatform",
      message: t.savePlatformSuccess,
      values,
    };
  },
};

async function saveMessagePlatformCredentials(
  workspaceId: string,
  values: MessagePlatformFormValues,
  previous: CockpitChannelEditorValues,
  t: {
    saveFeishuRequired: string;
    saveInfoflowRequired: string;
    saveQqbotRequired: string;
    savePlatformFailed: string;
  },
): Promise<{ status: number; message: string } | null> {
  const merged = mergeMessagePlatformCredentials(previous, credentialPatchFromForm(values));
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
      message: error instanceof Error ? error.message : t.savePlatformFailed,
    };
  }
}

function defaultMessagePlatformAdapter(editor: CockpitChannelEditorValues): MessagePlatformAdapter {
  if (!editor.infoflowEnabled) return "infoflow";
  if (!editor.qqbotEnabled) return "qqbot";
  if (!editor.feishuEnabled) return "feishu";
  return "infoflow";
}

function readMessagePlatformForm(formData: FormData): MessagePlatformFormValues {
  return {
    adapter: parseAdapter(formText(formData, "adapter")),
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

function credentialPatchFromForm(
  values: MessagePlatformFormValues,
): MessagePlatformCredentialPatch {
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
      throw new Error(`unsupported message platform adapter: ${String(_exhaustive)}`);
    }
  }
}

function parseAdapter(raw: string): MessagePlatformAdapter {
  return isMessagePlatformAdapter(raw) ? raw : "infoflow";
}
