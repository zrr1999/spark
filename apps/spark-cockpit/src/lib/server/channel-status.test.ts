import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelsConfig } from "@zendev-lab/spark-channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  channelEditorValuesFromConfig,
  channelsConfigPath,
  DEFAULT_INFOFLOW_ENDPOINT,
  loadChannelsConfigForCockpit,
  loadChannelStatusForCockpit,
  saveChannelsConfigForCockpit,
  type CockpitChannelDaemonClient,
  type CockpitChannelStatusSnapshot,
} from "./channel-status";

const previousSparkHome = process.env.SPARK_HOME;
const workspaceId = "ws_demo";

afterEach(() => {
  if (previousSparkHome === undefined) {
    delete process.env.SPARK_HOME;
  } else {
    process.env.SPARK_HOME = previousSparkHome;
  }
});

describe("cockpit channel status", () => {
  it("uses daemon status as the runtime truth even when config is missing locally", async () => {
    const root = join(tmpdir(), `spark-channels-${Date.now()}-missing`);
    process.env.SPARK_HOME = root;
    const client = daemonClient();

    const status = await loadChannelStatusForCockpit(workspaceId, client);

    expect(client.status).toHaveBeenCalledWith(workspaceId);
    expect(status).toMatchObject({
      workspaceId,
      available: true,
      configured: false,
      state: "unconfigured",
      adapters: [],
    });
  });

  it("reports daemon adapter liveness without exposing stored secrets", async () => {
    const root = join(tmpdir(), `spark-channels-${Date.now()}-ok`);
    process.env.SPARK_HOME = root;
    const path = channelsConfigPath(workspaceId);
    await mkdir(join(root, "workspaces", workspaceId, "channels"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        adapters: {
          feishu: {
            type: "feishu",
            event_mode: "websocket",
            app_id: "cli_secret",
            app_secret: "do-not-leak",
          },
        },
        routes: { ops: { adapter: "feishu", recipient: "oc_demo" } },
        ingress: { enabled: true, on_unbound: "reject" },
      }),
      "utf8",
    );
    const client = daemonClient({
      configured: true,
      ingressEnabled: true,
      state: "running",
      adapters: [{ id: "feishu", type: "feishu", running: true }],
      routes: [{ name: "ops", adapter: "feishu", recipient: "oc_demo" }],
      text: "channels running adapters=1/1 routes=1 ingress=on\n",
    });

    const status = await loadChannelStatusForCockpit(workspaceId, client);

    expect(status.adapters).toEqual([{ id: "feishu", type: "feishu", running: true }]);
    expect(JSON.stringify(status)).not.toContain("do-not-leak");
    const editor = channelEditorValuesFromConfig(
      (await loadChannelsConfigForCockpit(workspaceId)).config,
    );
    expect(editor.feishuAppSecret).toBe("");
    expect(editor.feishuAppSecretSet).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("does not infer running state from a local draft config", async () => {
    const root = join(tmpdir(), `spark-channels-${Date.now()}-draft`);
    process.env.SPARK_HOME = root;
    await mkdir(join(root, "workspaces", workspaceId, "channels"), { recursive: true });
    await writeFile(
      channelsConfigPath(workspaceId),
      JSON.stringify({
        adapters: {
          infoflow: { type: "infoflow" },
          feishu: { type: "feishu", event_mode: "websocket" },
        },
        routes: {},
        ingress: { enabled: false, on_unbound: "reject" },
      }),
      "utf8",
    );

    const status = await loadChannelStatusForCockpit(workspaceId, daemonClient());
    expect(status).toMatchObject({ configured: false, adapters: [] });

    const editor = channelEditorValuesFromConfig(
      (await loadChannelsConfigForCockpit(workspaceId)).config,
    );
    expect(editor.feishuEnabled).toBe(false);
    expect(editor.infoflowEnabled).toBe(false);
    expect(editor.infoflowEndpoint).toBe(DEFAULT_INFOFLOW_ENDPOINT);
  });

  it("sends validated editor config to daemon and waits for its acknowledgement", async () => {
    const root = join(tmpdir(), `spark-channels-${Date.now()}-save`);
    process.env.SPARK_HOME = root;
    const client = daemonClient({ configured: true, state: "stopped" });

    const saved = await saveChannelsConfigForCockpit(
      workspaceId,
      {
        feishuEnabled: false,
        feishuAppId: "",
        feishuAppSecret: "",
        feishuAppSecretSet: false,
        infoflowEnabled: true,
        infoflowEndpoint: "",
        infoflowAppKey: "key_demo",
        infoflowAppAgentId: "",
        infoflowAppSecret: "secret_demo",
        infoflowAppSecretSet: false,
        infoflowAllowedUserIds: "",
        infoflowGroupPolicy: "disabled",
        infoflowAllowedGroupIds: "",
        routeName: "ops",
        routeAdapter: "infoflow",
        routeRecipient: "",
        ingressEnabled: false,
        onUnbound: "reject",
      },
      client,
    );

    expect(client.configure).toHaveBeenCalledOnce();
    expect(client.configure).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        adapters: {
          infoflow: expect.objectContaining({
            endpoint: DEFAULT_INFOFLOW_ENDPOINT,
            app_key: "key_demo",
            app_secret: "secret_demo",
            group_policy: "disabled",
          }),
        },
        ingress: expect.objectContaining({
          enabled: true,
        }),
      }),
    );
    expect(saved.status.state).toBe("stopped");
    await expect(readFile(saved.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a stored secret when sending an editor patch to daemon", async () => {
    const root = join(tmpdir(), `spark-channels-${Date.now()}-keep-secret`);
    process.env.SPARK_HOME = root;
    const path = channelsConfigPath(workspaceId);
    await mkdir(join(root, "workspaces", workspaceId, "channels"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        adapters: {
          infoflow: {
            type: "infoflow",
            endpoint: DEFAULT_INFOFLOW_ENDPOINT,
            app_key: "key_demo",
            app_secret: "secret_keep",
          },
        },
        routes: {},
        ingress: { enabled: false, on_unbound: "reject" },
      }),
    );
    const editor = channelEditorValuesFromConfig(
      (await loadChannelsConfigForCockpit(workspaceId)).config,
    );
    const client = daemonClient({ configured: true, state: "stopped" });

    await saveChannelsConfigForCockpit(
      workspaceId,
      { ...editor, infoflowAppKey: "key_updated", infoflowAppSecret: "" },
      client,
    );

    expect(client.configure).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        adapters: {
          infoflow: expect.objectContaining({
            app_key: "key_updated",
            app_secret: "secret_keep",
          }),
        },
      }),
    );
  });
});

function daemonClient(overrides: Partial<DaemonStatusFixture> = {}): CockpitChannelDaemonClient & {
  status: ReturnType<typeof vi.fn>;
  configure: ReturnType<typeof vi.fn>;
} {
  const status = daemonStatus(overrides);
  return {
    status: vi.fn(async (_workspaceId: string) => status),
    configure: vi.fn(async (_workspaceId: string, _config: ChannelsConfig) => status),
  };
}

type DaemonStatusFixture = CockpitChannelStatusSnapshot & {
  plane: "daemon";
  resource: "channel";
  available: true;
  state: Exclude<CockpitChannelStatusSnapshot["state"], "unavailable">;
};

function daemonStatus(overrides: Partial<DaemonStatusFixture> = {}): DaemonStatusFixture {
  const root = process.env.SPARK_HOME ?? "/tmp/spark";
  return {
    plane: "daemon" as const,
    resource: "channel" as const,
    workspaceId,
    configPath: join(root, "workspaces", workspaceId, "channels", "config.json"),
    available: true as const,
    configured: false,
    ingressEnabled: false,
    state: "unconfigured",
    adapters: [],
    routes: [],
    observedAt: new Date().toISOString(),
    text: "channels not configured\n",
    ...overrides,
  };
}
