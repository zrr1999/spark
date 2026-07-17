import type { ChannelsConfig } from "@zendev-lab/spark-channels";
import type { RuntimeEphemeralSecretRequestContext } from "@zendev-lab/spark-coordination/runtime-model-channel-control";
import type { SparkChannelControlSnapshot } from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  channelAdapterCredentialsComplete,
  channelEditorValuesFromProjection,
  DEFAULT_INFOFLOW_ENDPOINT,
  emptyChannelEditorValues,
  loadChannelStatusForCockpit,
  mergeMessagePlatformCredentials,
  saveChannelsConfigForCockpit,
  type CockpitChannelDaemonClient,
} from "./channel-status";

const workspaceId = "ws_11111111111111111111111111111111";
const secretContext: RuntimeEphemeralSecretRequestContext = {
  actorUserId: "usr_11111111111111111111111111111111",
  browserRequestId: "msg_11111111111111111111111111111111",
  csrfVerified: true,
  pageProtocol: "https:",
};

describe("Cockpit channel runtime adapter", () => {
  it("uses the redacted daemon projection as status and editor truth", async () => {
    const client = daemonClient({
      configured: true,
      ingressEnabled: true,
      state: "running",
      adapters: [
        {
          id: "infoflow",
          type: "infoflow",
          running: true,
          state: "connected",
        },
      ],
      configuration: {
        infoflow: {
          endpoint: DEFAULT_INFOFLOW_ENDPOINT,
          appKeySet: true,
          appAgentId: "43163",
          appSecretSet: true,
          allowedUserIds: [],
          groupPolicy: "disabled",
          groupTrigger: "mention",
          allowedGroupIds: [],
          systemPrompt: "",
        },
        routes: [],
        onUnbound: "create",
      },
    });

    const status = await loadChannelStatusForCockpit(workspaceId, client);
    const editor = channelEditorValuesFromProjection(status.configuration);

    expect(client.status).toHaveBeenCalledWith(workspaceId);
    expect(editor).toMatchObject({
      infoflowEnabled: true,
      infoflowAppKey: "",
      infoflowAppKeySet: true,
      infoflowAppSecret: "",
      infoflowAppSecretSet: true,
      infoflowAppAgentId: "43163",
    });
    expect(JSON.stringify({ status, editor })).not.toContain("secret-marker");
  });

  it("sends credentials only through the explicit secure configure context", async () => {
    const client = daemonClient({ configured: true, state: "stopped" });
    const values = {
      ...emptyChannelEditorValues(),
      infoflowEnabled: true,
      infoflowEndpoint: "",
      infoflowAppKey: "key-marker",
      infoflowAppAgentId: "43163",
      infoflowAppSecret: "secret-marker",
      onUnbound: "reject" as const,
    };

    const saved = await saveChannelsConfigForCockpit(workspaceId, values, secretContext, client);

    expect(client.configure).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        adapters: {
          infoflow: expect.objectContaining({
            endpoint: DEFAULT_INFOFLOW_ENDPOINT,
            app_key: "key-marker",
            app_secret: "secret-marker",
            app_agent_id: "43163",
          }),
        },
      }),
      secretContext,
    );
    expect(saved.status.state).toBe("stopped");
  });

  it("represents existing private values with booleans and blank form fields", () => {
    const editor = channelEditorValuesFromProjection({
      feishu: { appId: "cli", appSecretSet: true },
      infoflow: {
        endpoint: DEFAULT_INFOFLOW_ENDPOINT,
        appKeySet: true,
        appAgentId: "43163",
        appSecretSet: true,
        allowedUserIds: [],
        groupPolicy: "disabled",
        groupTrigger: "mention",
        allowedGroupIds: [],
        systemPrompt: "",
      },
      routes: [],
      onUnbound: "create",
    });

    expect(editor.feishuAppSecret).toBe("");
    expect(editor.infoflowAppKey).toBe("");
    expect(editor.infoflowAppSecret).toBe("");
    expect(channelAdapterCredentialsComplete(editor, "feishu")).toBe(true);
    expect(channelAdapterCredentialsComplete(editor, "infoflow")).toBe(true);
  });

  it("merges one account patch without dropping another projected adapter", () => {
    const previous = {
      ...emptyChannelEditorValues(),
      feishuEnabled: true,
      feishuAppId: "cli_keep",
      feishuAppSecretSet: true,
    };
    const merged = mergeMessagePlatformCredentials(previous, {
      adapter: "infoflow",
      infoflowAppKey: "key_new",
      infoflowAppAgentId: "43163",
      infoflowAppSecret: "secret_new",
    });

    expect(merged).toMatchObject({
      feishuEnabled: true,
      feishuAppId: "cli_keep",
      infoflowEnabled: true,
      infoflowAppKey: "key_new",
      infoflowAppAgentId: "43163",
      infoflowAppSecret: "secret_new",
    });
  });
});

function daemonClient(overrides: Partial<SparkChannelControlSnapshot> = {}) {
  const status = daemonStatus(overrides);
  return {
    status: vi.fn(async (_workspaceId: string) => status),
    configure: vi.fn(
      async (
        _workspaceId: string,
        _config: ChannelsConfig,
        _context: RuntimeEphemeralSecretRequestContext,
      ) => status,
    ),
    reload: vi.fn(async (_workspaceId: string) => status),
  } satisfies CockpitChannelDaemonClient & {
    status: ReturnType<typeof vi.fn>;
    configure: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
}

function daemonStatus(
  overrides: Partial<SparkChannelControlSnapshot> = {},
): SparkChannelControlSnapshot {
  return {
    workspaceId,
    available: true as const,
    configured: false,
    ingressEnabled: false,
    state: "unconfigured" as const,
    adapters: [],
    routes: [],
    configuration: { routes: [], onUnbound: "create" },
    observedAt: "2026-07-15T00:00:00.000Z",
    text: "channels not configured\n",
    ...overrides,
  };
}
