/**
 * Channel ingress wiring for Spark daemon.
 *
 * Adapters deliver IncomingMessage → session resolve/bind → assignment.create
 * normalized onto session.run / task.start. Adapters never own session tables.
 *
 * Config is workspace-scoped:
 *   $SPARK_DATA_ROOT/workspaces/<workspaceId>/channels/config.json
 * Legacy global `$SPARK_DATA_ROOT/channels/config.json` is migrated on demand.
 */

import {
  channelDeliveryNotSent,
  ChannelRegistry,
  parseChannelsConfig,
  type ChannelAdapterType,
  type ChannelAskRequest,
  type ChannelAskSendResult,
  type ChannelDeliveryFacts,
  type ChannelDeliveryResult,
  type ChannelInteractionAckStatus,
  type ChannelMessageSendInput,
  type ChannelMessageTarget,
  type ChannelNotifyInput,
  type ChannelNotifyResult,
  type ChannelRegistryOptions,
  type ChannelReplyRecovery,
  type ChannelReplySendInput,
  type ChannelReplyStream,
  type ChannelReplyTarget,
  type ChannelsConfig,
  type IncomingMessage,
  type RoutedChannelInteractionEvent,
} from "@zendev-lab/spark-channels";
import { parseSparkAssignment, type SparkAssignment } from "@zendev-lab/spark-protocol";
import { writePrivateFile } from "@zendev-lab/spark-system";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "../session-registry.ts";
import type { SparkDaemonChannelContext } from "../core/types.ts";
import type { DaemonChannelTransportFactory } from "./transport-factory.ts";

export const CHANNEL_INGRESS_FAILURE_REPLY = "消息暂时无法处理，请稍后重试。";

export interface ChannelIngressAssignment {
  sessionId: string;
  goal: string;
  assignment: SparkAssignment;
  source: { kind: "channel"; channel: "feishu" | "infoflow" | "qqbot"; externalRef?: string };
  externalKey: string;
  /** Rename-stable provider account identity; never a local adapter routing label. */
  adapterAccountIdentity?: string;
  channelReply: {
    workspaceId: string;
    /** Platform semantics; adapterId remains the configured instance route. */
    adapter?: ChannelAdapterType;
    adapterId: string;
    recipient: string;
  };
  /** Platform facts for this inbound turn, kept out of the canonical user message body. */
  channelContext?: SparkDaemonChannelContext;
}

export interface ChannelIngressHooks {
  onAssignment: (input: ChannelIngressAssignment) => Promise<void | "duplicate">;
  /** Persist an admission-failure reply before considering the inbound handled. */
  onRejectedReply?: (input: ChannelIngressRejectedReply) => Promise<void>;
  /** Persist normalized ingress before session resolution and task admission. */
  onInboundReceived?: (input: { workspaceId: string; message: IncomingMessage }) => void;
  onReply?: (input: { externalKey: string; text: string; adapterId: string }) => Promise<void>;
  onInteraction?: (input: {
    workspaceId: string;
    event: RoutedChannelInteractionEvent;
  }) => Promise<void>;
  /**
   * Optional text-ask settlement for adapters without native interaction events.
   * Return "settled" to suppress ordinary turn admission for this inbound.
   */
  onTextAskReply?: (input: {
    workspaceId: string;
    message: IncomingMessage;
    recipient: string;
  }) => Promise<"settled" | "continue">;
}

export interface ChannelIngressRejectedReply {
  sessionId: string;
  workspaceId: string;
  externalKey: string;
  adapterAccountIdentity: string;
  adapterId: string;
  target: ChannelReplyTarget;
  text: string;
  /** Stable for platform redelivery when the inbound message has an id. */
  deliveryIdentity: string;
  deliveryFacts: ChannelDeliveryFacts;
  send(deliveryId: string): Promise<ChannelDeliveryResult>;
}

export interface ChannelIngressController {
  start(): Promise<void>;
  stop(): Promise<void>;
  admitInbound(message: IncomingMessage): Promise<void>;
  notify(input: ChannelNotifyInput): Promise<ChannelNotifyResult>;
  openReplyStream(
    adapterId: string,
    target: ChannelReplyTarget,
    options?: { onCreated?: (stream: ChannelReplyStream) => void | Promise<void> },
  ): Promise<ChannelReplyStream | undefined>;
  messageDeliveryFacts(adapterId: string, target: ChannelMessageTarget): ChannelDeliveryFacts;
  sendMessage(adapterId: string, input: ChannelMessageSendInput): Promise<ChannelDeliveryResult>;
  sendReply(adapterId: string, input: ChannelReplySendInput): Promise<ChannelDeliveryResult | void>;
  resolveAdapterId(adapterId: string, adapterAccountIdentity?: string): string;
  replyDeliveryFacts(adapterId: string, target: ChannelReplyTarget): ChannelDeliveryFacts;
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
      adapterAccountIdentity?: string;
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
    adapterAccountIdentity?: string;
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
  admitInbound?(workspaceId: string, message: IncomingMessage): Promise<void>;
  status(workspaceId: string): DaemonChannelIngressStatus;
  configure(workspaceId: string, config: unknown): Promise<DaemonChannelIngressStatus>;
  reload(workspaceId: string): Promise<DaemonChannelIngressStatus>;
  notify(workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult>;
  openReplyStream(
    workspaceId: string,
    adapterId: string,
    target: ChannelReplyTarget,
    options?: { onCreated?: (stream: ChannelReplyStream) => void | Promise<void> },
  ): Promise<ChannelReplyStream | undefined>;
  sendMessage(
    workspaceId: string,
    adapterId: string,
    input: ChannelMessageSendInput,
  ): Promise<ChannelDeliveryResult>;
  sendReply(
    workspaceId: string,
    adapterId: string,
    input: ChannelReplySendInput,
  ): Promise<ChannelDeliveryResult | void>;
  resolveAdapterId(workspaceId: string, adapterId: string, adapterAccountIdentity?: string): string;
  replyDeliveryFacts(
    workspaceId: string,
    adapterId: string,
    target: ChannelReplyTarget,
  ): ChannelDeliveryFacts;
  messageDeliveryFacts(
    workspaceId: string,
    adapterId: string,
    target: ChannelMessageTarget,
  ): ChannelDeliveryFacts;
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
  /** Install the text-ask settlement path for adapters without native controls. */
  setTextAskHandler?(handler?: ChannelIngressHooks["onTextAskReply"]): void;
  /** Install a daemon-owned durable ingress receipt before transports start. */
  setInboundHandler?(handler?: ChannelIngressHooks["onInboundReceived"]): void;
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
  createWorkspaceTransport?: DaemonChannelTransportFactory;
}): ChannelIngressController {
  const sessionRegistry = input.sessionRegistry ?? createDaemonSessionRegistry(input.sparkHome);
  const activeHandlers = new Set<Promise<void>>();
  const trackHandler = (
    operation: Promise<void>,
    label: "inbound" | "interaction",
  ): Promise<void> => {
    // Observe failures for drain/diagnostics without replacing the original
    // rejecting promise returned to transports. QQ uses that rejection to
    // avoid advancing its resume sequence before durable settlement.
    const tracked = operation.then(
      () => undefined,
      (error) => {
        console.error(`[spark-channels] ${label} failed`, error);
      },
    );
    activeHandlers.add(tracked);
    void tracked.finally(() => activeHandlers.delete(tracked));
    return operation;
  };
  const waitForHandlers = async () => {
    while (activeHandlers.size > 0) {
      await Promise.all([...activeHandlers]);
    }
  };
  const channelRegistry = new ChannelRegistry({
    config: input.config,
    ...(input.createTransport || input.createWorkspaceTransport
      ? {
          createTransport: (adapterId, config) =>
            input.createWorkspaceTransport?.({
              workspaceId: input.workspaceId,
              adapterId,
              config,
            }) ?? input.createTransport?.(adapterId, config),
        }
      : {}),
    onMessage: (message) => {
      if (Object.keys(input.config.adapters).length === 0 || !message.text.trim()) return;
      // A daemon persistence hook is intentionally invoked before converting
      // to a Promise. Synchronous SQLite failures propagate to transports so
      // an SDK must not ACK an event that never acquired a durable receipt.
      if (input.hooks.onInboundReceived) {
        input.hooks.onInboundReceived({ workspaceId: input.workspaceId, message });
        return;
      }
      void trackHandler(handleInbound(message), "inbound");
    },
    onInteraction: (event) =>
      trackHandler(
        input.hooks.onInteraction?.({ workspaceId: input.workspaceId, event }) ?? Promise.resolve(),
        "interaction",
      ),
  });

  async function handleInbound(message: IncomingMessage): Promise<void> {
    if (Object.keys(input.config.adapters).length === 0) return;
    if (!message.text.trim()) return;
    const replyRecipient = channelReplyRecipient(message);
    if (!replyRecipient) {
      throw new Error(`channel inbound missing reply recipient: ${message.externalKey}`);
    }
    if (input.hooks.onTextAskReply) {
      const textAsk = await input.hooks.onTextAskReply({
        workspaceId: input.workspaceId,
        message,
        recipient: replyRecipient,
      });
      if (textAsk === "settled") return;
    }
    const incomingAdapter = resolveIncomingAdapter(message, channelRegistry.listAdapters());
    const session = await sessionRegistry.resolveBinding({
      externalKey: message.externalKey,
      ...(message.adapterId || message.adapterAccountIdentity
        ? {
            adapterId: incomingAdapter.adapterId,
            adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
            allowLegacyAccountClaim: incomingAdapter.sameTypeAccountCount === 1,
          }
        : {}),
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
        adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
        channelReply: {
          workspaceId: input.workspaceId,
          adapter: channel,
          adapterId: incomingAdapter.adapterId,
          recipient: replyRecipient,
        },
        ...(channel === "infoflow" || channel === "qqbot"
          ? { channelContext: channelContextFromIncoming(message) }
          : {}),
      });
    } catch (error) {
      try {
        const target: ChannelReplyTarget = {
          recipient: replyRecipient,
          ...(message.senderId?.trim() ? { senderId: message.senderId.trim() } : {}),
          ...(message.messageId?.trim() ? { messageId: message.messageId.trim() } : {}),
          ...(rawGoal ? { preview: rawGoal.slice(0, 240) } : {}),
        };
        const deliveryIdentity = channelFailureReplyDeliveryId(
          {
            ...message,
            adapterId: incomingAdapter.adapterId,
            adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
          },
          input.workspaceId,
        );
        const rejectedReply: ChannelIngressRejectedReply = {
          sessionId: session.sessionId,
          workspaceId: input.workspaceId,
          externalKey: message.externalKey,
          adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
          adapterId: incomingAdapter.adapterId,
          target,
          text: CHANNEL_INGRESS_FAILURE_REPLY,
          deliveryIdentity,
          deliveryFacts: channelRegistry.replyDeliveryFacts(incomingAdapter.adapterId, target),
          send: async (deliveryId) =>
            await channelRegistry.sendReply(incomingAdapter.adapterId, {
              ...target,
              text: CHANNEL_INGRESS_FAILURE_REPLY,
              deliveryId,
            }),
        };
        if (input.hooks.onRejectedReply) {
          // Production persists this intent in the generic channel outbox.
          // Once durable, this inbound is handled and must not be retried.
          await input.hooks.onRejectedReply(rejectedReply);
        } else {
          await rejectedReply.send(deliveryIdentity);
        }
        return;
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
    admitInbound: handleInbound,
    notify: async (notifyInput) => await channelRegistry.notify(notifyInput),
    openReplyStream: async (adapterId, target, options) =>
      await channelRegistry.openReplyStream(adapterId, target, options),
    messageDeliveryFacts: (adapterId, target) =>
      channelRegistry.messageDeliveryFacts(adapterId, target),
    sendMessage: async (adapterId, messageInput) =>
      await channelRegistry.sendMessage(adapterId, messageInput),
    sendReply: async (adapterId, replyInput) =>
      await channelRegistry.sendReply(adapterId, replyInput),
    resolveAdapterId: (adapterId, adapterAccountIdentity) =>
      resolveControllerAdapterId(channelRegistry, adapterId, adapterAccountIdentity),
    replyDeliveryFacts: (adapterId, target) =>
      channelRegistry.replyDeliveryFacts(adapterId, target),
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
  const messageId = channelIngressMessageId(assignment);
  if (!messageId) return undefined;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        2,
        assignment.channelReply.workspaceId,
        assignment.source.channel,
        assignment.adapterAccountIdentity,
        assignment.externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel-ingress:${digest}`;
}

/** Read-only key for invocations admitted before stable account identities. */
export function channelIngressLegacyIdempotencyKey(
  assignment: ChannelIngressAssignment,
): string | undefined {
  const messageId = channelIngressMessageId(assignment);
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

function channelIngressMessageId(assignment: ChannelIngressAssignment): string | undefined {
  return assignment.source.externalRef?.trim() || assignment.channelContext?.messageId?.trim();
}

export function channelFailureReplyDeliveryId(
  message: IncomingMessage,
  workspaceId: string,
): string {
  const messageId = message.messageId?.trim();
  if (!messageId) return `channel-ingress-failure:${randomUUID()}`;
  const workspace = workspaceId.trim();
  const adapterAccountIdentity = message.adapterAccountIdentity?.trim();
  if (!workspace || !adapterAccountIdentity) {
    throw new Error(
      "workspaceId and adapterAccountIdentity are required for channel failure delivery identity",
    );
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        2,
        "rejected",
        workspace,
        message.adapter,
        adapterAccountIdentity,
        message.externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel-ingress-failure:${digest}`;
}

type IngressAdapterStatus = ReturnType<ChannelRegistry["listAdapters"]>[number];

function resolveIncomingAdapter(
  message: IncomingMessage,
  adapters: IngressAdapterStatus[],
): {
  adapterId: string;
  adapterAccountIdentity: string;
  sameTypeAccountCount: number;
} {
  const sameType = adapters.filter((adapter) => adapter.type === message.adapter);
  const requestedId = message.adapterId?.trim();
  const requestedIdentity = message.adapterAccountIdentity?.trim();
  let selected: IngressAdapterStatus | undefined;

  if (requestedIdentity) {
    const matches = sameType.filter(
      (adapter) => adapter.adapterAccountIdentity === requestedIdentity,
    );
    if (matches.length !== 1) {
      throw channelDeliveryNotSent(
        new Error(
          matches.length === 0
            ? `channel provider account is not configured (previous adapter ${requestedId || message.adapter})`
            : `channel provider account is ambiguous: ${matches
                .map((adapter) => adapter.id)
                .sort()
                .join(", ")}`,
        ),
      );
    }
    selected = matches[0];
  } else if (requestedId) {
    selected = sameType.find((adapter) => adapter.id === requestedId);
  } else if (sameType.length === 1) {
    // Compatibility for inbound rows persisted before adapter instance facts.
    selected = sameType[0];
  }

  if (!selected && !requestedIdentity && requestedId === message.adapter && sameType.length === 1) {
    selected = sameType[0];
  }
  if (!selected) {
    throw channelDeliveryNotSent(
      new Error(
        sameType.length > 1
          ? `legacy ${message.adapter} inbound is ambiguous across adapters: ${sameType
              .map((adapter) => adapter.id)
              .sort()
              .join(", ")}`
          : `channel adapter is not configured: ${requestedId || message.adapter}`,
      ),
    );
  }
  const adapterAccountIdentity = selected.adapterAccountIdentity?.trim();
  if (!adapterAccountIdentity) {
    throw channelDeliveryNotSent(
      new Error(`channel adapter ${selected.id} has no stable provider account identity`),
    );
  }
  return {
    adapterId: selected.id,
    adapterAccountIdentity,
    sameTypeAccountCount: sameType.length,
  };
}

function resolveControllerAdapterId(
  registry: Pick<ChannelRegistry, "listAdapters">,
  legacyAdapterId: string,
  adapterAccountIdentity?: string,
): string {
  const adapters = registry.listAdapters();
  const fallbackId = legacyAdapterId.trim();
  if (!fallbackId) throw channelDeliveryNotSent(new Error("channel adapter id is required"));
  const stableIdentity = adapterAccountIdentity?.trim();
  if (stableIdentity) {
    const matches = adapters.filter((adapter) => adapter.adapterAccountIdentity === stableIdentity);
    if (matches.length === 1) return matches[0]!.id;
    throw channelDeliveryNotSent(
      new Error(
        matches.length === 0
          ? `channel provider account is not configured (previous adapter ${fallbackId})`
          : `channel provider account is ambiguous: ${matches
              .map((adapter) => adapter.id)
              .sort()
              .join(", ")}`,
      ),
    );
  }

  if (adapters.some((adapter) => adapter.id === fallbackId)) return fallbackId;
  const sameType = adapters.filter((adapter) => adapter.type === fallbackId);
  if (sameType.length === 1) return sameType[0]!.id;
  throw channelDeliveryNotSent(
    new Error(
      sameType.length > 1
        ? `legacy channel adapter ${fallbackId} is ambiguous: ${sameType
            .map((adapter) => adapter.id)
            .sort()
            .join(", ")}`
        : `channel adapter is not configured: ${fallbackId}`,
    ),
  );
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
    ...(message.images?.length ? { images: message.images } : {}),
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

/** Platform-owned identity; Cockpit renders the technical key with adapter/scope labels. */
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
  createWorkspaceTransport?: DaemonChannelTransportFactory;
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
      ...(input.createWorkspaceTransport
        ? { createWorkspaceTransport: input.createWorkspaceTransport }
        : {}),
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
    admitInbound: async (workspaceId, message) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw new Error(`channels not configured for workspace ${workspaceId}`);
      }
      await slot.controller.admitInbound(message);
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
    openReplyStream: async (workspaceId, adapterId, target, options) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw channelDeliveryNotSent(
          new Error(`channels not configured for workspace ${workspaceId}`),
        );
      }
      return await slot.controller.openReplyStream(adapterId, target, options);
    },
    sendMessage: async (workspaceId, adapterId, messageInput) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw channelDeliveryNotSent(
          new Error(`channels not configured for workspace ${workspaceId}`),
        );
      }
      return await slot.controller.sendMessage(adapterId, messageInput);
    },
    sendReply: async (workspaceId, adapterId, replyInput) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw channelDeliveryNotSent(
          new Error(`channels not configured for workspace ${workspaceId}`),
        );
      }
      return await slot.controller.sendReply(adapterId, replyInput);
    },
    resolveAdapterId: (workspaceId, adapterId, adapterAccountIdentity) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw channelDeliveryNotSent(
          new Error(`channels not configured for workspace ${workspaceId}`),
        );
      }
      return slot.controller.resolveAdapterId(adapterId, adapterAccountIdentity);
    },
    replyDeliveryFacts: (workspaceId, adapterId, target) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw channelDeliveryNotSent(
          new Error(`channels not configured for workspace ${workspaceId}`),
        );
      }
      try {
        return slot.controller.replyDeliveryFacts(adapterId, target);
      } catch (error) {
        throw channelDeliveryNotSent(error);
      }
    },
    messageDeliveryFacts: (workspaceId, adapterId, target) => {
      const slot = getSlot(workspaceId);
      if (!slot.controller) {
        throw channelDeliveryNotSent(
          new Error(`channels not configured for workspace ${workspaceId}`),
        );
      }
      try {
        return slot.controller.messageDeliveryFacts(adapterId, target);
      } catch (error) {
        throw channelDeliveryNotSent(error);
      }
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
    setTextAskHandler: (handler) => {
      input.hooks.onTextAskReply = handler;
    },
    setInboundHandler: (handler) => {
      input.hooks.onInboundReceived = handler;
    },
    listWorkspaceIds: async () => await listWorkspaceChannelIds(input.sparkHome),
  };
}
