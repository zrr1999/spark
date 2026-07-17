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
  type ChannelAskRequest,
  type ChannelAskSendResult,
  type ChannelInteractionAckStatus,
  type ChannelReplyStream,
  type ChannelReplyRecovery,
  type ChannelReplyTarget,
  type ChannelRegistryOptions,
  type IncomingMessage,
  type RoutedChannelInteractionEvent,
} from "@zendev-lab/spark-channels";
import { parseSparkAssignment, type SparkAssignment } from "@zendev-lab/spark-protocol";
import { writePrivateFile } from "@zendev-lab/spark-system";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "../session-registry.ts";
import type { SparkDaemonChannelContext } from "../core/types.ts";

export const CHANNEL_INGRESS_FAILURE_REPLY = "消息暂时无法处理，请稍后重试。";

export interface ChannelIngressAssignment {
  sessionId: string;
  goal: string;
  assignment: SparkAssignment;
  source: { kind: "channel"; channel: "feishu" | "infoflow" | "qqbot"; externalRef?: string };
  externalKey: string;
  channelReply: {
    workspaceId: string;
    adapterId: string;
    recipient: string;
  };
  /** Platform facts for this inbound turn, kept out of the canonical user message body. */
  channelContext?: SparkDaemonChannelContext;
}

export interface ChannelIngressHooks {
  onAssignment: (input: ChannelIngressAssignment) => Promise<void | "duplicate">;
  onReply?: (input: { externalKey: string; text: string; adapterId: string }) => Promise<void>;
  onInteraction?: (input: {
    workspaceId: string;
    event: RoutedChannelInteractionEvent;
  }) => Promise<void>;
}

export interface ChannelIngressController {
  start(): Promise<void>;
  stop(): Promise<void>;
  notify(input: ChannelNotifyInput): Promise<ChannelNotifyResult>;
  openReplyStream(
    adapterId: string,
    target: ChannelReplyTarget,
  ): Promise<ChannelReplyStream | undefined>;
  sendReply(adapterId: string, input: ChannelReplyTarget & { text: string }): Promise<void>;
  recoverReply(
    adapterId: string,
    input: ChannelReplyTarget & {
      text: string;
      deliveryId: string;
      recovery: ChannelReplyRecovery;
    },
  ): Promise<void>;
  sendAsk(
    adapterId: string,
    recipient: string,
    request: ChannelAskRequest,
  ): Promise<ChannelAskSendResult>;
  ackInteraction(
    adapterId: string,
    interactionId: string,
    status?: ChannelInteractionAckStatus,
  ): Promise<void>;
  status(): {
    configured: boolean;
    ingressEnabled: boolean;
    adapters: Array<{
      id: string;
      type: string;
      running: boolean;
      state: "stopped" | "connecting" | "connected" | "reconnecting" | "degraded";
      error?: string;
    }>;
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
  adapters: Array<{
    id: string;
    type: string;
    running: boolean;
    state: "stopped" | "connecting" | "connected" | "reconnecting" | "degraded";
    error?: string;
  }>;
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
  openReplyStream(
    workspaceId: string,
    adapterId: string,
    target: ChannelReplyTarget,
  ): Promise<ChannelReplyStream | undefined>;
  sendReply(
    workspaceId: string,
    adapterId: string,
    input: ChannelReplyTarget & { text: string },
  ): Promise<void>;
  recoverReply(
    workspaceId: string,
    adapterId: string,
    input: ChannelReplyTarget & {
      text: string;
      deliveryId: string;
      recovery: ChannelReplyRecovery;
    },
  ): Promise<void>;
  sendAsk(
    workspaceId: string,
    adapterId: string,
    recipient: string,
    request: ChannelAskRequest,
  ): Promise<ChannelAskSendResult>;
  ackInteraction(
    workspaceId: string,
    adapterId: string,
    interactionId: string,
    status?: ChannelInteractionAckStatus,
  ): Promise<void>;
  /** Install the daemon-owned native interaction router after construction. */
  setInteractionHandler?(handler?: ChannelIngressHooks["onInteraction"]): void;
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
  sessionRegistry?: Pick<DaemonSessionRegistry, "resolveBinding"> &
    Partial<Pick<DaemonSessionRegistry, "recordTurnQueued" | "recordTurnSettled">>;
  workspaceId: string;
  createTransport?: ChannelRegistryOptions["createTransport"];
}): ChannelIngressController {
  const sessionRegistry = input.sessionRegistry ?? createDaemonSessionRegistry(input.sparkHome);
  const activeHandlers = new Set<Promise<void>>();
  const trackHandler = (operation: Promise<void>, label: "inbound" | "interaction") => {
    const tracked = operation.catch((error) => {
      console.error(`[spark-channels] ${label} failed`, error);
    });
    activeHandlers.add(tracked);
    void tracked.finally(() => activeHandlers.delete(tracked));
  };
  const waitForHandlers = async () => {
    while (activeHandlers.size > 0) {
      await Promise.all([...activeHandlers]);
    }
  };
  const channelRegistry = new ChannelRegistry({
    config: input.config,
    ...(input.createTransport ? { createTransport: input.createTransport } : {}),
    onMessage: (message) => {
      trackHandler(handleInbound(message), "inbound");
    },
    onInteraction: (event) => {
      trackHandler(
        input.hooks.onInteraction?.({ workspaceId: input.workspaceId, event }) ?? Promise.resolve(),
        "interaction",
      );
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
        title: channelSessionTitle(message),
      },
    });
    const channel = message.adapter;
    const rawGoal = message.text.trim();
    const assignment = parseSparkAssignment({
      goal: rawGoal,
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
    let admission: void | "duplicate";
    try {
      admission = await input.hooks.onAssignment({
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
        ...(channel === "infoflow" || channel === "qqbot"
          ? { channelContext: channelContextFromIncoming(message) }
          : {}),
      });
    } catch (error) {
      try {
        await channelRegistry.sendReply(channel, {
          recipient: replyRecipient,
          ...(message.senderId?.trim() ? { senderId: message.senderId.trim() } : {}),
          ...(message.messageId?.trim() ? { messageId: message.messageId.trim() } : {}),
          ...(rawGoal ? { preview: rawGoal.slice(0, 240) } : {}),
          text: CHANNEL_INGRESS_FAILURE_REPLY,
        });
      } catch (replyError) {
        console.error("[spark-channels] failed to report rejected inbound", replyError);
      }
      throw error;
    }
    if (admission !== "duplicate") {
      // Update the visible session state only after durable admission. A
      // platform redelivery may refer to an invocation that is still running;
      // toggling running -> ready around that duplicate would hide the real
      // in-flight turn from Cockpit. Registry projection failure is advisory:
      // the invocation is already durable and must not receive a false failure
      // reply merely because its visible status could not be updated.
      try {
        await sessionRegistry.recordTurnQueued?.(session.sessionId);
      } catch (error) {
        console.error("[spark-channels] failed to mark admitted inbound as queued", error);
      }
    }
  }

  return {
    start: async () => {
      await channelRegistry.startAll();
    },
    stop: async () => {
      let stopError: unknown;
      try {
        await channelRegistry.stopAll();
      } catch (error) {
        stopError = error;
      }
      await waitForHandlers();
      if (stopError) throw stopError;
    },
    notify: async (notifyInput) => await channelRegistry.notify(notifyInput),
    openReplyStream: async (adapterId, target) =>
      await channelRegistry.openReplyStream(adapterId, target),
    sendReply: async (adapterId, replyInput) =>
      await channelRegistry.sendReply(adapterId, replyInput),
    recoverReply: async (adapterId, replyInput) =>
      await channelRegistry.recoverReply(adapterId, replyInput),
    sendAsk: async (adapterId, recipient, request) =>
      await channelRegistry.sendAsk(adapterId, recipient, request),
    ackInteraction: async (adapterId, interactionId, status) =>
      await channelRegistry.ackInteraction(adapterId, interactionId, status),
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

/**
 * Durable platform admission key. Only a platform-issued message id is stable
 * enough to deduplicate across daemon restarts; message text is intentionally
 * excluded so identical intentional messages remain distinct.
 */
export function channelIngressIdempotencyKey(
  assignment: ChannelIngressAssignment,
): string | undefined {
  const messageId =
    assignment.source.externalRef?.trim() || assignment.channelContext?.messageId?.trim();
  if (!messageId) return undefined;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        assignment.channelReply.workspaceId,
        assignment.channelReply.adapterId,
        assignment.source.channel,
        assignment.externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel-ingress:${digest}`;
}

function channelContextFromIncoming(message: IncomingMessage): SparkDaemonChannelContext {
  return {
    externalKey: message.externalKey,
    ...(message.senderId?.trim() ? { senderId: message.senderId.trim() } : {}),
    ...(message.senderName?.trim() ? { senderName: message.senderName.trim() } : {}),
    ...(message.chatId?.trim() ? { chatId: message.chatId.trim() } : {}),
    ...(message.messageId?.trim() ? { messageId: message.messageId.trim() } : {}),
    ...(message.eventType?.trim() ? { eventType: message.eventType.trim() } : {}),
    ...(message.contentType?.trim() ? { contentType: message.contentType.trim() } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.mentions?.length
      ? { mentions: message.mentions.map((entry) => entry.trim()).filter(Boolean) }
      : {}),
    ...(typeof message.mentionedSelf === "boolean" ? { mentionedSelf: message.mentionedSelf } : {}),
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
    case "qqbot": {
      if (message.externalKey.startsWith("qqbot:group:") && message.chatId?.trim()) {
        return `group:${message.chatId.trim()}`;
      }
      if (message.externalKey.startsWith("qqbot:channel:") && message.chatId?.trim()) {
        return `channel:${message.chatId.trim()}`;
      }
      const openid = message.senderId?.trim();
      return openid ? `c2c:${openid}` : undefined;
    }
    default: {
      const unexpected: never = message.adapter;
      throw new Error(`unsupported channel adapter: ${String(unexpected)}`);
    }
  }
}

/** Prefer a human label in the stored title while keeping the channel key shape. */
function channelSessionTitle(message: IncomingMessage): string {
  if (message.adapter === "qqbot" && message.externalKey.startsWith("qqbot:c2c:")) {
    const label = message.senderName?.trim();
    if (label) return `channel qqbot:c2c:${label}`;
  }
  return `channel ${message.externalKey}`;
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
    const connectedCount = adapters.filter(
      (adapter) => adapter.running && adapter.state === "connected",
    ).length;
    const adapterError = adapters.find((adapter) => adapter.error)?.error;
    const statusError = slot.lastError ?? adapterError;
    const state = statusError
      ? "degraded"
      : !slot.config
        ? "unconfigured"
        : ingressEnabled && connectedCount === adapters.length && adapters.length > 0
          ? "running"
          : runningCount > 0
            ? "degraded"
            : "stopped";
    const observedAt = now().toISOString();
    const text = statusError
      ? `channels workspace=${slot.workspaceId} degraded connected=${connectedCount}/${adapters.length} routes=${routes.length} ingress=${
          ingressEnabled ? "on" : "off"
        } error=${statusError}\n`
      : !slot.config
        ? `channels workspace=${slot.workspaceId} not configured (${slot.configPath})\n`
        : `channels workspace=${slot.workspaceId} ${state} connected=${connectedCount}/${adapters.length} routes=${routes.length} ingress=${
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
      ...(statusError ? { error: statusError } : {}),
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
    openReplyStream: async (workspaceId, adapterId, target) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw new Error(`channels not configured for workspace ${workspaceId}`);
      }
      return await slot.controller.openReplyStream(adapterId, target);
    },
    sendReply: async (workspaceId, adapterId, replyInput) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw new Error(`channels not configured for workspace ${workspaceId}`);
      }
      await slot.controller.sendReply(adapterId, replyInput);
    },
    recoverReply: async (workspaceId, adapterId, replyInput) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw new Error(`channels not configured for workspace ${workspaceId}`);
      }
      await slot.controller.recoverReply(adapterId, replyInput);
    },
    sendAsk: async (workspaceId, adapterId, recipient, request) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw new Error(`channels not configured for workspace ${workspaceId}`);
      }
      return await slot.controller.sendAsk(adapterId, recipient, request);
    },
    ackInteraction: async (workspaceId, adapterId, interactionId, status) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw new Error(`channels not configured for workspace ${workspaceId}`);
      }
      await slot.controller.ackInteraction(adapterId, interactionId, status);
    },
    setInteractionHandler: (handler) => {
      input.hooks.onInteraction = handler;
    },
    listWorkspaceIds: async () => await listWorkspaceChannelIds(input.sparkHome),
  };
}
