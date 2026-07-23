import {
  parseSparkAssignment,
  sparkTurnCancelResultSchema,
  sparkTurnSubmitResultSchema,
  type SparkAssignment,
  type SparkInvocationStatus,
  type SparkTurnAttachment,
} from "@zendev-lab/spark-protocol";
import { createCockpitRuntimeSessionClient } from "./cockpit-runtime-session-client";
import { conversationTurnIdempotencyKey } from "./conversation-submission";

export interface SubmitCockpitConversationTurnInput {
  workspaceId?: string;
  sessionId: string;
  prompt: string;
  title: string;
  /** Opaque browser-generated nonce reused only when retrying the same submit. */
  submissionId?: string;
  attachments?: SparkTurnAttachment[];
}

export interface SubmittedCockpitConversationTurn {
  turnId: string;
}

export interface CancelCockpitConversationTurnInput {
  turnId: string;
  sessionId: string;
  reason?: string;
}

export interface CancelledCockpitConversationTurn {
  turnId: string;
  status: SparkInvocationStatus;
  cancelRequested: boolean;
}

export interface CockpitConversationControlClient {
  submit(input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
    messageMetadata?: Record<string, unknown>;
    attachments?: SparkTurnAttachment[];
    idempotencyKey?: string;
  }): Promise<unknown>;
}

export interface CockpitConversationCancelClient {
  cancel(input: { sessionId: string; invocationId: string; reason?: string }): Promise<unknown>;
}

const runtimeConversationControlClient = createCockpitRuntimeSessionClient();

/**
 * Submit every Cockpit message through the daemon conversation control plane.
 * Channel ingress and the Web UI therefore append to the same native session
 * transcript instead of executing through separate Web-only task machinery.
 */
export async function submitConversationTurnForCockpit(
  input: SubmitCockpitConversationTurnInput,
  client: CockpitConversationControlClient = runtimeConversationControlClient,
): Promise<SubmittedCockpitConversationTurn> {
  const assignment = parseSparkAssignment({
    goal: input.prompt,
    title: input.title,
    target: {
      sessionId: input.sessionId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
    constraints: [],
    evidence: [],
    source: { kind: "cockpit" },
  });
  const idempotencyKey = conversationTurnIdempotencyKey(input.sessionId, input.submissionId);
  const result = await client.submit({
    sessionId: input.sessionId,
    prompt: input.prompt,
    assignment,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    messageMetadata: {
      origin: { kind: "user", host: "web", surface: "local" },
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map(({ kind, name, mediaType, size }) => ({
              kind,
              name,
              mediaType,
              size,
            })),
          }
        : {}),
    },
  });
  const receipt = sparkTurnSubmitResultSchema.safeParse(result);
  if (!receipt.success)
    throw new Error("Spark daemon returned an invalid conversation turn receipt.");
  return { turnId: receipt.data.invocationId };
}

/** Cancel a queued or active daemon turn after binding it to the selected session. */
export async function cancelConversationTurnForCockpit(
  input: CancelCockpitConversationTurnInput,
  client: CockpitConversationCancelClient = runtimeConversationControlClient,
): Promise<CancelledCockpitConversationTurn> {
  const turnId = input.turnId.trim();
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("Select a conversation before cancelling its turn.");
  if (!turnId) throw new Error("Select a queued or active conversation turn to cancel.");
  const reason = input.reason?.trim();
  const result = await client.cancel({
    sessionId,
    invocationId: turnId,
    ...(reason ? { reason } : {}),
  });
  const receipt = sparkTurnCancelResultSchema.safeParse(result);
  if (!receipt.success) {
    throw new Error("Spark daemon returned an invalid conversation turn cancellation receipt.");
  }
  return {
    turnId,
    status: receipt.data.status,
    cancelRequested: receipt.data.cancelRequested,
  };
}
