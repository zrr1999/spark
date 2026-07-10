/**
 * Channel ingress wiring for Spark daemon.
 *
 * Adapters deliver IncomingMessage → session resolve/bind → assignment.create
 * normalized onto session.run / task.start. Adapters never own session tables.
 *
 * Config is workspace-scoped:
 *   $SPARK_HOME/workspaces/<workspaceId>/channels/config.json
 * Legacy global `$SPARK_HOME/channels/config.json` is migrated on demand.
 */

import {
  ChannelRegistry,
  parseChannelsConfig,
  type ChannelsConfig,
  type ChannelNotifyInput,
  type ChannelNotifyResult,
  type ChannelRegistryOptions,
  type IncomingMessage,
} from "@zendev-lab/spark-channels";
import { parseSparkAssignment, type SparkAssignment } from "@zendev-lab/spark-protocol";
import { writePrivateFile } from "@zendev-lab/spark-system";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "../session-registry.ts";

export interface ChannelIngressAssignment {
  sessionId: string;
  goal: string;
  assignment: SparkAssignment;
  source: { kind: "channel"; channel: "feishu" | "infoflow"; externalRef?: string };
  externalKey: string;
  channelReply: {
    workspaceId: string;
    adapterId: string;
    recipient: string;
  };
}

export interface ChannelIngressHooks {
  onAssignment: (input: ChannelIngressAssignment) => Promise<void>;
  onReply?: (input: { externalKey: string; text: string; adapterId: string }) => Promise<void>;
}

export interface ChannelIngressController {
  start(): Promise<void>;
  stop(): Promise<void>;
  notify(input: ChannelNotifyInput): Promise<ChannelNotifyResult>;
  status(): {
    configured: boolean;
    ingressEnabled: boolean;
    adapters: Array<{ id: string; type: string; running: boolean }>;
    routes: Array<{ name: string; adapter: string; recipient: string }>;
  };
}

export interface DaemonChannelIngressStatus {
  plane: "daemon";
  resource: "channel";
  workspaceId: string;
  configPath: string;
  available: true;
  configured: boolean;
  ingressEnabled: boolean;
  state: "unconfigured" | "running" | "stopped" | "degraded";
  adapters: Array<{ id: string; type: string; running: boolean }>;
  routes: Array<{ name: string; adapter: string; recipient: string }>;
  lastReloadedAt?: string;
  error?: string;
  observedAt: string;
  text: string;
}

/**
 * Stable daemon-owned channel control surface shared by startup and local RPC.
 * Each workspace has its own config file and ingress controller.
 */
export interface DaemonChannelIngressRuntime {
  start(): Promise<DaemonChannelIngressStatus[]>;
  stop(): Promise<void>;
  status(workspaceId: string): DaemonChannelIngressStatus;
  configure(workspaceId: string, config: unknown): Promise<DaemonChannelIngressStatus>;
  reload(workspaceId: string): Promise<DaemonChannelIngressStatus>;
  notify(workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult>;
  listWorkspaceIds(): Promise<string[]>;
}

export function legacyChannelsConfigPath(sparkHome: string): string {
  return join(sparkHome, "channels", "config.json");
}

export function workspaceChannelsConfigPath(sparkHome: string, workspaceId: string): string {
  const id = workspaceId.trim();
  if (!id) throw new Error("workspaceId is required for channel config");
  return join(sparkHome, "workspaces", id, "channels", "config.json");
}

export async function listWorkspaceChannelIds(sparkHome: string): Promise<string[]> {
  const root = join(sparkHome, "workspaces");
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    try {
      await readFile(workspaceChannelsConfigPath(sparkHome, entry), "utf8");
      ids.push(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return ids.sort();
}

/**
 * Move legacy global channels config into a workspace path once.
 * Returns true when a migration write happened.
 */
export async function migrateLegacyChannelsConfig(
  sparkHome: string,
  workspaceId: string,
): Promise<boolean> {
  const dest = workspaceChannelsConfigPath(sparkHome, workspaceId);
  try {
    await readFile(dest, "utf8");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const legacy = legacyChannelsConfigPath(sparkHome);
  let raw: string;
  try {
    raw = await readFile(legacy, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  parseChannelsConfig(JSON.parse(raw) as unknown);
  await mkdir(dirname(dest), { recursive: true });
  writePrivateFile(dest, raw.endsWith("\n") ? raw : `${raw}\n`);
  try {
    await rename(legacy, `${legacy}.migrated`);
  } catch {
    // Best-effort; workspace file is the source of truth after migration.
  }
  return true;
}

export async function loadDaemonChannelsConfig(
  sparkHome: string,
  workspaceId: string,
): Promise<{ path: string; config: ChannelsConfig | null }> {
  const path = workspaceChannelsConfigPath(sparkHome, workspaceId);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return { path, config: parseChannelsConfig(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, config: null };
    }
    throw error;
  }
}

export function createChannelIngressController(input: {
  sparkHome: string;
  config: ChannelsConfig;
  hooks: ChannelIngressHooks;
  sessionRegistry?: Pick<DaemonSessionRegistry, "resolveBinding">;
  workspaceId: string;
  createTransport?: ChannelRegistryOptions["createTransport"];
}): ChannelIngressController {
  const sessionRegistry = input.sessionRegistry ?? createDaemonSessionRegistry(input.sparkHome);
  const channelRegistry = new ChannelRegistry({
    config: input.config,
    ...(input.createTransport ? { createTransport: input.createTransport } : {}),
    onMessage: (message) => {
      void handleInbound(message).catch((error) => {
        console.error("[spark-channels] inbound failed", error);
      });
    },
  });

  async function handleInbound(message: IncomingMessage): Promise<void> {
    if (Object.keys(input.config.adapters).length === 0) return;
    if (!message.text.trim()) return;
    const session = await sessionRegistry.resolveBinding({
      externalKey: message.externalKey,
      onUnbound: input.config.ingress?.on_unbound ?? "create",
      create: {
        workspaceId: input.workspaceId,
        title: `channel ${message.externalKey}`,
      },
    });
    const channel = message.adapter;
    const assignment = parseSparkAssignment({
      goal: message.text.trim(),
      target: { sessionId: session.sessionId, workspaceId: input.workspaceId },
      source: {
        kind: "channel",
        channel,
        ...(message.messageId ? { externalRef: message.messageId } : {}),
      },
    });
    const replyRecipient = channelReplyRecipient(message);
    if (!replyRecipient) {
      console.error("[spark-channels] inbound missing reply recipient", message.externalKey);
      return;
    }
    await input.hooks.onAssignment({
      sessionId: session.sessionId,
      goal: assignment.goal,
      assignment,
      source: {
        kind: "channel",
        channel,
        ...(message.messageId ? { externalRef: message.messageId } : {}),
      },
      externalKey: message.externalKey,
      channelReply: {
        workspaceId: input.workspaceId,
        adapterId: channel,
        recipient: replyRecipient,
      },
    });
  }

  return {
    start: async () => {
      await channelRegistry.startAll();
    },
    stop: async () => {
      await channelRegistry.stopAll();
    },
    notify: async (notifyInput) => await channelRegistry.notify(notifyInput),
    status: () => ({
      configured: true,
      ingressEnabled: channelRegistry.ingressEnabled,
      adapters: channelRegistry.listAdapters(),
      routes: channelRegistry.listRoutes().map((route) => ({
        name: route.name,
        adapter: route.adapterId,
        recipient: route.recipient,
      })),
    }),
  };
}

function channelReplyRecipient(message: IncomingMessage): string | undefined {
  switch (message.adapter) {
    case "infoflow": {
      if (message.externalKey.startsWith("infoflow:group:") && message.chatId?.trim()) {
        return `group:${message.chatId.trim()}`;
      }
      return message.senderId?.trim() || undefined;
    }
    case "feishu":
      return message.chatId?.trim() || undefined;
    default: {
      const unexpected: never = message.adapter;
      throw new Error(`unsupported channel adapter: ${String(unexpected)}`);
    }
  }
}

type WorkspaceSlot = {
  workspaceId: string;
  configPath: string;
  controller: ChannelIngressController | null;
  config: ChannelsConfig | null;
  lastReloadedAt?: string;
  lastError?: string;
  transition: Promise<void>;
};

export function createDaemonChannelIngressRuntime(input: {
  sparkHome: string;
  hooks: ChannelIngressHooks;
  sessionRegistry?: Pick<DaemonSessionRegistry, "resolveBinding">;
  /** @deprecated Ignored; pass workspaceId to status/configure/reload/notify. */
  workspaceId?: string;
  createTransport?: ChannelRegistryOptions["createTransport"];
  now?: () => Date;
}): DaemonChannelIngressRuntime {
  const now = input.now ?? (() => new Date());
  const sessionRegistry = input.sessionRegistry ?? createDaemonSessionRegistry(input.sparkHome);
  const slots = new Map<string, WorkspaceSlot>();

  const getSlot = (workspaceId: string): WorkspaceSlot => {
    const id = workspaceId.trim();
    if (!id) throw new Error("workspaceId is required");
    const existing = slots.get(id);
    if (existing) return existing;
    const slot: WorkspaceSlot = {
      workspaceId: id,
      configPath: workspaceChannelsConfigPath(input.sparkHome, id),
      controller: null,
      config: null,
      transition: Promise.resolve(),
    };
    slots.set(id, slot);
    return slot;
  };

  const serialize = <T>(slot: WorkspaceSlot, operation: () => Promise<T>): Promise<T> => {
    const current = slot.transition.then(operation, operation);
    slot.transition = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const createController = (
    workspaceId: string,
    nextConfig: ChannelsConfig,
  ): ChannelIngressController => {
    const next = createChannelIngressController({
      sparkHome: input.sparkHome,
      config: nextConfig,
      hooks: input.hooks,
      sessionRegistry,
      workspaceId,
      ...(input.createTransport ? { createTransport: input.createTransport } : {}),
    });
    next.status();
    return next;
  };

  const restorePrevious = async (
    slot: WorkspaceSlot,
    previous: ChannelIngressController | null,
    failed: ChannelIngressController | null,
    cause: unknown,
  ): Promise<never> => {
    try {
      await failed?.stop();
    } catch {
      // Preserve the transition's original error; status records it below.
    }
    try {
      await previous?.start();
    } catch (rollbackError) {
      const original = cause instanceof Error ? cause.message : String(cause);
      const rollback =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      slot.lastError = `${original}; channel ingress rollback failed: ${rollback}`;
      throw new Error(slot.lastError);
    }
    slot.lastError = cause instanceof Error ? cause.message : String(cause);
    throw cause;
  };

  const statusOf = (slot: WorkspaceSlot): DaemonChannelIngressStatus => {
    const runtime = slot.controller?.status();
    const adapters = runtime?.adapters ?? [];
    const routes = runtime?.routes ?? [];
    const ingressEnabled =
      runtime?.ingressEnabled ?? Object.keys(slot.config?.adapters ?? {}).length > 0;
    const runningCount = adapters.filter((adapter) => adapter.running).length;
    const state = slot.lastError
      ? "degraded"
      : !slot.config
        ? "unconfigured"
        : ingressEnabled && runningCount === adapters.length && adapters.length > 0
          ? "running"
          : "stopped";
    const observedAt = now().toISOString();
    const text = slot.lastError
      ? `channels workspace=${slot.workspaceId} degraded adapters=${runningCount}/${adapters.length} routes=${routes.length} ingress=${
          ingressEnabled ? "on" : "off"
        } error=${slot.lastError}\n`
      : !slot.config
        ? `channels workspace=${slot.workspaceId} not configured (${slot.configPath})\n`
        : `channels workspace=${slot.workspaceId} ${state} adapters=${runningCount}/${adapters.length} routes=${routes.length} ingress=${
            ingressEnabled ? "on" : "off"
          }\n`;
    return {
      plane: "daemon",
      resource: "channel",
      workspaceId: slot.workspaceId,
      configPath: slot.configPath,
      available: true,
      configured: slot.config !== null,
      ingressEnabled,
      state,
      adapters,
      routes,
      ...(slot.lastReloadedAt ? { lastReloadedAt: slot.lastReloadedAt } : {}),
      ...(slot.lastError ? { error: slot.lastError } : {}),
      observedAt,
      text,
    };
  };

  const replace = async (
    slot: WorkspaceSlot,
    nextConfig: ChannelsConfig | null,
    options: { persist: boolean },
  ): Promise<DaemonChannelIngressStatus> => {
    const previous = slot.controller;
    if (!nextConfig) {
      await previous?.stop();
      slot.controller = null;
      slot.config = null;
      slot.lastError = undefined;
      slot.lastReloadedAt = now().toISOString();
      return statusOf(slot);
    }

    const next = createController(slot.workspaceId, nextConfig);
    try {
      await previous?.stop();
      await next.start();
      if (options.persist) {
        await mkdir(dirname(slot.configPath), { recursive: true });
        writePrivateFile(slot.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
      }
    } catch (error) {
      return await restorePrevious(slot, previous, next, error);
    }

    slot.controller = next;
    slot.config = nextConfig;
    slot.lastError = undefined;
    slot.lastReloadedAt = now().toISOString();
    return statusOf(slot);
  };

  const reloadWorkspace = async (workspaceId: string): Promise<DaemonChannelIngressStatus> => {
    const slot = getSlot(workspaceId);
    return await serialize(slot, async () => {
      try {
        await migrateLegacyChannelsConfig(input.sparkHome, workspaceId);
        const loaded = await loadDaemonChannelsConfig(input.sparkHome, workspaceId);
        return await replace(slot, loaded.config, { persist: false });
      } catch (error) {
        slot.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  };

  return {
    start: async () => {
      const ids = await listWorkspaceChannelIds(input.sparkHome);
      if (ids.length === 0) {
        // No workspace configs yet — leave legacy in place until a workspace configure/migrate.
        return [];
      }
      const statuses: DaemonChannelIngressStatus[] = [];
      for (const id of ids) {
        statuses.push(await reloadWorkspace(id));
      }
      return statuses;
    },
    stop: async () => {
      for (const slot of slots.values()) {
        await serialize(slot, async () => {
          await slot.controller?.stop();
        });
      }
    },
    status: (workspaceId) => statusOf(getSlot(workspaceId)),
    configure: (workspaceId, value) => {
      const parsed = parseChannelsConfig(value);
      const slot = getSlot(workspaceId);
      return serialize(slot, async () => await replace(slot, parsed, { persist: true }));
    },
    reload: (workspaceId) => reloadWorkspace(workspaceId),
    notify: async (workspaceId, notifyInput) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw new Error(`channels not configured for workspace ${workspaceId}`);
      }
      return await slot.controller.notify(notifyInput);
    },
    listWorkspaceIds: async () => await listWorkspaceChannelIds(input.sparkHome),
  };
}
