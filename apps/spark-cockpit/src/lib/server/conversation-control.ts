import { parseSparkAssignment, type SparkAssignment } from "@zendev-lab/spark-protocol";
import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-system";

export interface SubmitCockpitConversationTurnInput {
  workspaceId?: string;
  sessionId: string;
  prompt: string;
  title: string;
}

export interface SubmittedCockpitConversationTurn {
  turnId: string;
}

export interface CancelCockpitConversationTurnInput {
  /** Queue fileName returned as `turnId` by submitConversationTurnForCockpit. */
  turnId: string;
  sessionId: string;
  reason?: string;
}

export type CockpitConversationTurnCancelOutcome = "cancel-requested" | "dequeued" | "not-found";

export interface CancelledCockpitConversationTurn {
  turnId: string;
  cancelled: boolean;
  outcome: CockpitConversationTurnCancelOutcome;
  message: string;
}

export interface CockpitConversationControlClient {
  submit(input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
  }): Promise<unknown>;
}

export interface CockpitConversationCancelClient {
  cancel(input: { invocationId: string; sessionId: string; reason?: string }): Promise<unknown>;
}

const daemonConversationControlClient: CockpitConversationControlClient &
  CockpitConversationCancelClient = {
  submit: async (input) => await requestSparkDaemonLocalRpc<unknown>("turn.submit", input),
  cancel: async (input) => await requestSparkDaemonLocalRpc<unknown>("turn.cancel", input),
};

/**
 * Submit every Cockpit message through the daemon conversation control plane.
 * Channel ingress and the Web UI therefore append to the same native session
 * transcript instead of executing through separate Web-only task machinery.
 */
export async function submitConversationTurnForCockpit(
  input: SubmitCockpitConversationTurnInput,
  client: CockpitConversationControlClient = daemonConversationControlClient,
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
  const result = await client.submit({
    sessionId: input.sessionId,
    prompt: input.prompt,
    assignment,
  });
  if (!isRecord(result) || typeof result.fileName !== "string" || !result.fileName.trim()) {
    throw new Error("Spark daemon returned an invalid conversation turn receipt.");
  }
  return { turnId: result.fileName };
}

/** Cancel a queued or active daemon turn after binding it to the selected session. */
export async function cancelConversationTurnForCockpit(
  input: CancelCockpitConversationTurnInput,
  client: CockpitConversationCancelClient = daemonConversationControlClient,
): Promise<CancelledCockpitConversationTurn> {
  const turnId = input.turnId.trim();
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("Select a conversation before cancelling its turn.");
  if (!turnId) throw new Error("Select a queued or active conversation turn to cancel.");
  const reason = input.reason?.trim();
  const result = await client.cancel({
    invocationId: turnId,
    sessionId,
    ...(reason ? { reason } : {}),
  });
  if (
    !isRecord(result) ||
    typeof result.cancelled !== "boolean" ||
    !isTurnCancelOutcome(result.outcome) ||
    result.cancelled !== (result.outcome !== "not-found") ||
    typeof result.message !== "string" ||
    !result.message.trim()
  ) {
    throw new Error("Spark daemon returned an invalid conversation turn cancellation receipt.");
  }
  return {
    turnId,
    cancelled: result.cancelled,
    outcome: result.outcome,
    message: result.message,
  };
}

function isTurnCancelOutcome(value: unknown): value is CockpitConversationTurnCancelOutcome {
  return value === "cancel-requested" || value === "dequeued" || value === "not-found";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
