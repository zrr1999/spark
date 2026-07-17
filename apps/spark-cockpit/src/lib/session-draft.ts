export interface SessionDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const sessionDraftPrefix = "spark-cockpit.session-draft.v1";
const sessionPendingSubmissionPrefix = "spark-cockpit.session-submit.v1";
const startConversationPendingSubmissionPrefix = "spark-cockpit.start-submit.v1";

export interface SessionPendingSubmission {
  message: string;
  submissionId: string;
}

export interface StartConversationSubmissionContext {
  workspaceId: string;
  message: string;
  model: string;
  thinkingLevel: string;
}

export interface StartConversationPendingSubmission extends StartConversationSubmissionContext {
  submissionId: string;
}

export interface StartConversationDraftResolution {
  contextKey: string;
  pending: StartConversationPendingSubmission | null;
  submissionId: string;
}

function normalizeStartConversationSubmissionContext(
  context: StartConversationSubmissionContext,
): StartConversationSubmissionContext {
  return {
    workspaceId: context.workspaceId.trim(),
    message: context.message.trim(),
    model: context.model.trim(),
    thinkingLevel: context.thinkingLevel.trim(),
  };
}

export function startConversationSubmissionContextKey(
  context: StartConversationSubmissionContext,
): string {
  const normalized = normalizeStartConversationSubmissionContext(context);
  // A JSON tuple is unambiguous even when a value contains separators. Keep the
  // prompt out of the storage key itself; it lives only in the workspace-scoped
  // value and is compared exactly before a nonce can be reused.
  return JSON.stringify([
    normalized.workspaceId,
    normalized.message,
    normalized.model,
    normalized.thinkingLevel,
  ]);
}

export function startConversationPendingSubmissionStorageKey(workspaceId: string): string | null {
  const normalized = workspaceId.trim();
  return normalized
    ? `${startConversationPendingSubmissionPrefix}:${encodeURIComponent(normalized)}`
    : null;
}

export function readStartConversationPendingSubmission(
  storage: SessionDraftStorage,
  workspaceId: string,
): StartConversationPendingSubmission | null {
  const key = startConversationPendingSubmissionStorageKey(workspaceId);
  const raw = key ? storage.getItem(key) : null;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StartConversationPendingSubmission> | null;
    if (
      !value ||
      typeof value.workspaceId !== "string" ||
      typeof value.message !== "string" ||
      typeof value.model !== "string" ||
      typeof value.thinkingLevel !== "string" ||
      typeof value.submissionId !== "string"
    ) {
      return null;
    }
    const normalized = normalizeStartConversationSubmissionContext({
      workspaceId: value.workspaceId,
      message: value.message,
      model: value.model,
      thinkingLevel: value.thinkingLevel,
    });
    const submissionId = value.submissionId.trim();
    return normalized.workspaceId === workspaceId.trim() && normalized.message && submissionId
      ? { ...normalized, submissionId }
      : null;
  } catch {
    return null;
  }
}

export function startConversationPendingSubmissionMatches(
  pending: StartConversationPendingSubmission | null,
  context: StartConversationSubmissionContext,
): pending is StartConversationPendingSubmission {
  return Boolean(
    pending &&
    startConversationSubmissionContextKey(pending) ===
      startConversationSubmissionContextKey(context),
  );
}

export function resolveStartConversationDraftSubmission(input: {
  context: StartConversationSubmissionContext;
  pending: StartConversationPendingSubmission | null;
  previousContextKey: string;
  submissionId: string;
  createSubmissionId: () => string;
}): StartConversationDraftResolution {
  const context = normalizeStartConversationSubmissionContext(input.context);
  const previousContextKey = input.previousContextKey.trim();
  let submissionId = input.submissionId.trim();

  if (!context.workspaceId || !context.message) {
    if (!submissionId || previousContextKey) submissionId = input.createSubmissionId();
    return { contextKey: "", pending: null, submissionId };
  }

  const contextKey = startConversationSubmissionContextKey(context);
  if (startConversationPendingSubmissionMatches(input.pending, context)) {
    return { contextKey, pending: input.pending, submissionId: input.pending.submissionId };
  }

  if (!submissionId || (previousContextKey && previousContextKey !== contextKey)) {
    submissionId = input.createSubmissionId();
  }
  return {
    contextKey,
    pending: { ...context, submissionId },
    submissionId,
  };
}

export function writeStartConversationPendingSubmission(
  storage: SessionDraftStorage,
  workspaceId: string,
  pending: StartConversationPendingSubmission | null,
): void {
  const key = startConversationPendingSubmissionStorageKey(workspaceId);
  if (!key) return;
  if (!pending) {
    storage.removeItem(key);
    return;
  }
  const normalized = normalizeStartConversationSubmissionContext(pending);
  const submissionId = pending.submissionId.trim();
  if (normalized.workspaceId !== workspaceId.trim() || !normalized.message || !submissionId) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ ...normalized, submissionId }));
}

export function sessionDraftStorageKey(sessionId: string): string | null {
  const normalized = sessionId.trim();
  return normalized ? `${sessionDraftPrefix}:${normalized}` : null;
}

export function readSessionDraft(storage: SessionDraftStorage, sessionId: string): string {
  const key = sessionDraftStorageKey(sessionId);
  return key ? (storage.getItem(key) ?? "") : "";
}

export function writeSessionDraft(
  storage: SessionDraftStorage,
  sessionId: string,
  draft: string,
): void {
  const key = sessionDraftStorageKey(sessionId);
  if (!key) return;
  if (draft) {
    storage.setItem(key, draft);
    return;
  }
  storage.removeItem(key);
}

export function sessionPendingSubmissionStorageKey(sessionId: string): string | null {
  const normalized = sessionId.trim();
  return normalized ? `${sessionPendingSubmissionPrefix}:${normalized}` : null;
}

export function readSessionPendingSubmission(
  storage: SessionDraftStorage,
  sessionId: string,
): SessionPendingSubmission | null {
  const key = sessionPendingSubmissionStorageKey(sessionId);
  const raw = key ? storage.getItem(key) : null;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { message?: unknown }).message !== "string" ||
      typeof (value as { submissionId?: unknown }).submissionId !== "string"
    ) {
      return null;
    }
    const message = (value as { message: string }).message;
    const submissionId = (value as { submissionId: string }).submissionId.trim();
    return message && submissionId ? { message, submissionId } : null;
  } catch {
    return null;
  }
}

export function writeSessionPendingSubmission(
  storage: SessionDraftStorage,
  sessionId: string,
  pending: SessionPendingSubmission | null,
): void {
  const key = sessionPendingSubmissionStorageKey(sessionId);
  if (!key) return;
  const submissionId = pending?.submissionId.trim() ?? "";
  if (!pending?.message || !submissionId) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ message: pending.message, submissionId }));
}
