import { createHash } from "node:crypto";
import { createId, parseSparkAskChoice } from "@zendev-lab/spark-protocol";
import type { ChannelAskRequest, IncomingMessage } from "@zendev-lab/spark-channels";
import { renderTextChannelAsk } from "@zendev-lab/spark-channels";
import { runtimeEnvelope } from "../protocol/outbound.ts";
import type { SparkDaemonHumanInteractionOpened } from "../core/human-interactions.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitDeliveryOutcome,
  type SparkDaemonHumanWaitRecord,
} from "../core/human-waits.ts";
import type { ChannelIngressHooks, DaemonChannelIngressRuntime } from "./ingress.ts";
import type { DaemonChannelDeliveryOutbox } from "./delivery-outbox.ts";

/** Best-effort channel projection of a daemon-owned request. Cockpit remains authoritative. */
export async function projectChannelAsk(
  channelIngress: DaemonChannelIngressRuntime,
  input: SparkDaemonHumanInteractionOpened,
  deliveryOutbox?: Pick<DaemonChannelDeliveryOutbox, "enqueueAsk">,
): Promise<void> {
  const channel = input.channel;
  if (!channel) return;

  if (channel.adapterId === "qqbot") {
    await projectQqbotNativeAsk(channelIngress, input, deliveryOutbox);
    return;
  }

  if (channel.adapterId === "infoflow") {
    await projectInfoflowTextAsk(channelIngress, input, deliveryOutbox);
  }
}

async function projectQqbotNativeAsk(
  channelIngress: DaemonChannelIngressRuntime,
  input: SparkDaemonHumanInteractionOpened,
  deliveryOutbox?: Pick<DaemonChannelDeliveryOutbox, "enqueueAsk">,
): Promise<void> {
  const channel = input.channel;
  if (!channel || input.callbackOptions.length === 0) return;
  // Native group buttons must remain scoped to the original sender. The same
  // check is repeated when the callback arrives; this is only the platform hint.
  if (!channel.actorId) return;
  const question = input.request.questions[0]!;
  const descriptions = input.callbackOptions
    .filter((option) => option.description)
    .map((option) => `- **${option.label}**: ${option.description}`);
  const options = input.callbackOptions.slice(0, 25);
  const omitted = input.callbackOptions.length - options.length;
  const prompt = [
    `## ${input.request.title}`,
    question.prompt,
    ...(descriptions.length > 0 ? [descriptions.join("\n")] : []),
    ...(omitted > 0 ? [`另有 ${omitted} 个选项，请在 Spark Cockpit 中查看。`] : []),
  ].join("\n\n");
  const request: ChannelAskRequest = {
    prompt,
    options: options.map((option, index) => ({
      id: String(index + 1),
      label: option.label,
      data: option.token,
    })),
    audience: { kind: "users" as const, userIds: [channel.actorId] },
    ...(channel.messageId ? { messageId: channel.messageId } : {}),
    unsupportedText: "请在 Spark Cockpit 中回答。",
  };
  await deliverChannelAsk(
    channelIngress,
    channel,
    request,
    deliveryOutbox,
    input.wait.humanRequestId,
  );
}

async function projectInfoflowTextAsk(
  channelIngress: DaemonChannelIngressRuntime,
  input: SparkDaemonHumanInteractionOpened,
  deliveryOutbox?: Pick<DaemonChannelDeliveryOutbox, "enqueueAsk">,
): Promise<void> {
  const channel = input.channel;
  if (!channel) return;
  if (input.request.questions.length !== 1) return;
  const question = input.request.questions[0]!;
  const options =
    input.callbackOptions.length > 0
      ? input.callbackOptions
      : (question.options ?? []).map((option) => ({
          token: option.value,
          questionId: question.id,
          value: option.value,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        }));
  const prompt = renderTextChannelAsk({
    title: input.request.title,
    prompt: question.prompt,
    options: options.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  });
  const request: ChannelAskRequest = {
    prompt,
    options: options.slice(0, 25).map((option, index) => ({
      id: String(index + 1),
      label: option.label,
      data: option.token,
    })),
    ...(channel.actorId
      ? { audience: { kind: "users" as const, userIds: [channel.actorId] } }
      : {}),
    ...(channel.messageId ? { messageId: channel.messageId } : {}),
    unsupportedText: prompt,
  };
  await deliverChannelAsk(
    channelIngress,
    channel,
    request,
    deliveryOutbox,
    input.wait.humanRequestId,
  );
}

async function deliverChannelAsk(
  channelIngress: DaemonChannelIngressRuntime,
  channel: NonNullable<SparkDaemonHumanInteractionOpened["channel"]>,
  request: ChannelAskRequest,
  deliveryOutbox: Pick<DaemonChannelDeliveryOutbox, "enqueueAsk"> | undefined,
  humanRequestId: string,
): Promise<void> {
  if (deliveryOutbox) {
    await deliveryOutbox.enqueueAsk({
      idempotencyKey: `channel.ask:${humanRequestId}`,
      workspaceId: channel.workspaceId,
      adapterId: channel.adapterId,
      recipient: channel.recipient,
      request,
    });
    return;
  }
  await channelIngress.sendAsk(channel.workspaceId, channel.adapterId, channel.recipient, request);
}

/** Validate an opaque QQ callback, settle exactly one wait, then ACK the platform event. */
export async function settleChannelAskInteraction(
  channelIngress: DaemonChannelIngressRuntime,
  waits: SparkDaemonHumanWaitRegistry,
  input: Parameters<NonNullable<ChannelIngressHooks["onInteraction"]>>[0],
  options: {
    /** Legacy single-Cockpit override retained for focused callers/tests. */
    runtimeId?: string;
    /** Resolve the runtime that owns the callback's workspace route. */
    getRuntimeId?: (wait: SparkDaemonHumanWaitRecord) => string | undefined;
    deliveryOutbox?: Pick<DaemonChannelDeliveryOutbox, "enqueueInteractionAck">;
  },
): Promise<void> {
  const { event, workspaceId } = input;
  const callback = waits.findCallback(event.buttonData);
  if (!callback) {
    await deliverInteractionAck(channelIngress, event, workspaceId, "forbidden", options);
    return;
  }

  const channel = recordValue(callback.wait.context.channel);
  const expectedWorkspaceId = stringValue(channel?.workspaceId);
  const expectedAdapterId = stringValue(channel?.adapterId);
  const expectedRecipient = stringValue(channel?.recipient);
  const expectedActorId = stringValue(channel?.actorId);
  const routeMatches =
    expectedWorkspaceId === workspaceId &&
    expectedAdapterId === event.adapterId &&
    expectedActorId === event.actorId &&
    (!expectedRecipient || event.recipient === expectedRecipient);
  if (!routeMatches) {
    await deliverInteractionAck(channelIngress, event, workspaceId, "forbidden", options);
    return;
  }

  let outcome: SparkDaemonHumanWaitDeliveryOutcome;
  try {
    const runtimeId = options.getRuntimeId?.(callback.wait)?.trim() || options.runtimeId?.trim();
    if (!runtimeId) {
      throw new Error("daemon runtimeId is unavailable for channel response routing");
    }
    const humanResponseId = channelInteractionResponseId(event.adapterId, event.interactionId);
    const messageId = createId("msg");
    const payload = {
      source: "channel" as const,
      status: "answered" as const,
      answers: { [callback.questionId]: callback.value },
      responseArtifactRefs: [],
    };
    outcome = waits.deliver(
      {
        humanRequestId: callback.wait.humanRequestId,
        humanResponseId,
        status: payload.status,
        answers: payload.answers,
      },
      {
        messageId,
        kind: "human.response.recorded",
        envelope: runtimeEnvelope(
          "human.response.recorded",
          payload,
          {
            runtimeId,
            workspaceBindingId: callback.wait.workspaceBindingId || undefined,
            workspaceId: callback.wait.workspaceId || undefined,
            projectId: callback.wait.projectId || undefined,
            humanRequestId: callback.wait.humanRequestId,
            humanResponseId,
            invocationId: callback.wait.invocationId || undefined,
          },
          { messageId },
        ),
      },
    ).outcome;
  } catch (error) {
    await deliverInteractionAck(channelIngress, event, workspaceId, "rate_limited", options);
    throw error;
  }
  await deliverInteractionAck(
    channelIngress,
    event,
    workspaceId,
    channelInteractionAckStatus(outcome),
    options,
  );
}

/**
 * Correlate an ordinary Infoflow (text-fallback) reply with the oldest matching
 * pending ask. Returns "settled" so ingress must not start a competing turn.
 */
export async function settleChannelAskTextReply(
  waits: SparkDaemonHumanWaitRegistry,
  input: {
    workspaceId: string;
    message: IncomingMessage;
    recipient: string;
  },
  options: {
    runtimeId?: string;
    getRuntimeId?: (wait: SparkDaemonHumanWaitRecord) => string | undefined;
  },
): Promise<"settled" | "continue"> {
  if (input.message.adapter !== "infoflow") return "continue";
  const text = input.message.text.trim();
  if (!text) return "continue";

  const wait = findPendingInfoflowTextAsk(waits, {
    workspaceId: input.workspaceId,
    adapterId: input.message.adapter,
    recipient: input.recipient,
    actorId: input.message.senderId?.trim(),
  });
  if (!wait) return "continue";

  const answers = parseInfoflowTextAskAnswers(wait, text);
  if (!answers) return "continue";

  const runtimeId = options.getRuntimeId?.(wait)?.trim() || options.runtimeId?.trim();
  if (!runtimeId) {
    throw new Error("daemon runtimeId is unavailable for channel text-ask response routing");
  }

  const platformMessageId = input.message.messageId?.trim() || createId("msg");
  const humanResponseId = channelInteractionResponseId(
    input.message.adapter,
    `text:${platformMessageId}`,
  );
  const messageId = createId("msg");
  const payload = {
    source: "channel" as const,
    status: "answered" as const,
    answers,
    responseArtifactRefs: [],
  };
  waits.deliver(
    {
      humanRequestId: wait.humanRequestId,
      humanResponseId,
      status: payload.status,
      answers: payload.answers,
    },
    {
      messageId,
      kind: "human.response.recorded",
      envelope: runtimeEnvelope(
        "human.response.recorded",
        payload,
        {
          runtimeId,
          workspaceBindingId: wait.workspaceBindingId || undefined,
          workspaceId: wait.workspaceId || undefined,
          projectId: wait.projectId || undefined,
          humanRequestId: wait.humanRequestId,
          humanResponseId,
          invocationId: wait.invocationId || undefined,
        },
        { messageId },
      ),
    },
  );
  return "settled";
}

export function findPendingInfoflowTextAsk(
  waits: SparkDaemonHumanWaitRegistry,
  input: {
    workspaceId: string;
    adapterId: string;
    recipient: string;
    actorId?: string;
  },
): SparkDaemonHumanWaitRecord | null {
  for (const wait of waits.listPending()) {
    const channel = recordValue(wait.context.channel);
    if (!channel) continue;
    if (stringValue(channel.workspaceId) !== input.workspaceId) continue;
    if (stringValue(channel.adapterId) !== input.adapterId) continue;
    if (stringValue(channel.adapterId) === "qqbot") continue;
    if (stringValue(channel.recipient) !== input.recipient) continue;
    const expectedActor = stringValue(channel.actorId);
    if (expectedActor && expectedActor !== input.actorId) continue;
    return wait;
  }
  return null;
}

export function parseInfoflowTextAskAnswers(
  wait: SparkDaemonHumanWaitRecord,
  text: string,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const questions = wait.questions ?? [];
  if (questions.length !== 1) return null;
  const question = questions[0]!;
  const options = (question.options ?? []).map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));

  const indexed = /^(\d{1,2})$/u.exec(trimmed);
  if (indexed) {
    const option = options[Number(indexed[1]) - 1];
    if (option) return { [question.id]: option.value };
  }

  const choice = parseSparkAskChoice(options, trimmed, question.type ?? "single");
  if (choice.kind === "option" && choice.values[0]) {
    return { [question.id]: choice.values[0] };
  }
  if (choice.kind === "multi" && choice.values.length > 0) {
    return { [question.id]: choice.values };
  }
  if (choice.customText?.trim()) {
    return {
      [question.id]: {
        values: [],
        customText: choice.customText.trim(),
      },
    };
  }
  return null;
}

async function deliverInteractionAck(
  channelIngress: DaemonChannelIngressRuntime,
  event: Parameters<NonNullable<ChannelIngressHooks["onInteraction"]>>[0]["event"],
  workspaceId: string,
  status: Parameters<DaemonChannelIngressRuntime["ackInteraction"]>[3],
  options: {
    deliveryOutbox?: Pick<DaemonChannelDeliveryOutbox, "enqueueInteractionAck">;
  },
): Promise<void> {
  if (options.deliveryOutbox) {
    await options.deliveryOutbox.enqueueInteractionAck({
      idempotencyKey: `channel.interaction-ack:${event.adapterId}:${event.interactionId}`,
      workspaceId,
      adapterId: event.adapterId,
      interactionId: event.interactionId,
      status: status ?? "success",
    });
    return;
  }
  await channelIngress.ackInteraction(workspaceId, event.adapterId, event.interactionId, status);
}

function channelInteractionResponseId(adapterId: string, interactionId: string): string {
  const digest = createHash("sha256")
    .update(`${adapterId}\0${interactionId}`)
    .digest("hex")
    .slice(0, 32);
  return `hres_${digest}`;
}

function channelInteractionAckStatus(
  outcome: SparkDaemonHumanWaitDeliveryOutcome,
): "success" | "failed" | "rate_limited" | "duplicate" {
  switch (outcome) {
    case "accepted":
    case "replayed":
    case "orphaned":
      return "success";
    case "already_resolved":
      return "duplicate";
    case "transient":
      return "rate_limited";
    case "unknown_request":
      return "failed";
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
