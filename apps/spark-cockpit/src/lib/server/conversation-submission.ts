import { createHash } from "node:crypto";

export const MAX_CONVERSATION_SUBMISSION_ID_LENGTH = 128;

export function normalizeConversationSubmissionId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_CONVERSATION_SUBMISSION_ID_LENGTH) {
    throw new Error("Conversation submission id is too long.");
  }
  return normalized;
}

export function conversationTurnIdempotencyKey(
  sessionId: string,
  submissionId: string | undefined,
): string | undefined {
  const normalized = normalizeConversationSubmissionId(submissionId);
  if (!normalized) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify([1, "turn.submit", sessionId.trim(), normalized]))
    .digest("hex")
    .slice(0, 32);
  return `idem_${digest}`;
}

/** Stable session identity for retrying the first message after a lost HTTP response. */
export function conversationStartSessionId(
  workspaceId: string,
  submissionId: string | undefined,
): string | undefined {
  const normalized = normalizeConversationSubmissionId(submissionId);
  if (!normalized) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify([1, workspaceId.trim(), normalized]))
    .digest("hex")
    .slice(0, 32);
  return `sess_cockpit_${digest}`;
}
