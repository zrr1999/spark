import { createHash } from "node:crypto";
import { createId } from "@zendev-lab/spark-protocol";
import type { ChannelAskRequest } from "@zendev-lab/spark-channels";
import { runtimeEnvelope } from "../protocol/outbound.ts";
import type { SparkDaemonHumanInteractionOpened } from "../core/human-interactions.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitDeliveryOutcome,
} from "../core/human-waits.ts";
import type { ChannelIngressHooks, DaemonChannelIngressRuntime } from "./ingress.ts";
import type { DaemonChannelDeliveryOutbox } from "./delivery-outbox.ts";

/** Best-effort QQ projection of a daemon-owned request. Cockpit remains authoritative. */
export async function projectChannelAsk(
  channelIngress: DaemonChannelIngressRuntime,
  input: SparkDaemonHumanInteractionOpened,
  deliveryOutbox?: Pick<DaemonChannelDeliveryOutbox, "enqueueAsk">,
): Promise<void> {
  const channel = input.channel;
  if (!channel || channel.adapterId !== "qqbot" || input.callbackOptions.length === 0) return;
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
  if (deliveryOutbox) {
    await deliveryOutbox.enqueueAsk({
      idempotencyKey: `channel.ask:${input.wait.humanRequestId}`,
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
    runtimeId: string;
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
    (!event.recipient || !expectedRecipient || event.recipient === expectedRecipient);
  if (!routeMatches) {
    await deliverInteractionAck(channelIngress, event, workspaceId, "forbidden", options);
    return;
  }

  let outcome: SparkDaemonHumanWaitDeliveryOutcome;
  try {
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
            runtimeId: options.runtimeId,
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
