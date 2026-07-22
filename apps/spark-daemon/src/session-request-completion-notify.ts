import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";

import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import type { SparkDaemonSessionRunTask, SparkDaemonTask } from "./core/types.ts";
import {
  type CompleteSparkInvocationInput,
  type SparkInvocationRecord,
  SparkInvocationStore,
} from "./store/invocations.ts";

export const SESSION_REQUEST_COMPLETION_SOURCE_KIND = "session.request.completion";

export interface SessionRequestCompletionNotifyDependencies {
  invocationStore: Pick<SparkInvocationStore, "submit" | "findByIdempotencyKey">;
  sessionRegistry: Pick<DaemonSessionRegistry, "get" | "recordTurnQueued">;
  modelControl?: Pick<
    SparkDaemonModelControl,
    "effectiveModel" | "effectiveThinkingLevel" | "prepareModel"
  >;
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
  canAdmit?: () => boolean;
}

export interface SessionRequestCompletionNotifyResult {
  submitted: boolean;
  skippedReason?: string;
  invocationId?: string;
}

interface CompletionNotificationCandidate {
  mail: SessionMailMetadata;
  fromSessionId: string;
  idempotencyKey: string;
}

interface CompletionNotificationSender {
  session: SparkSessionRegistryRecord;
  cwd: string;
  model: Awaited<ReturnType<SparkDaemonModelControl["effectiveModel"]>> | undefined;
  thinkingLevel: Awaited<ReturnType<SparkDaemonModelControl["effectiveThinkingLevel"]>> | undefined;
}

/**
 * After an async session request (`wait=accepted`) reaches a terminal status,
 * submit one durable continuation on the originating sender session so it can
 * synthesize the child result immediately (default auto parent turn).
 *
 * Idempotent on `session.request.completion:${sourceInvocationId}`. Does not
 * fire for `wait=completed` callers (`notifyOnCompletion: false`).
 */
export async function notifySessionRequestCompletion(
  deps: SessionRequestCompletionNotifyDependencies,
  input: {
    invocation: SparkInvocationRecord;
    task: SparkDaemonTask;
    completion: CompleteSparkInvocationInput;
  },
): Promise<SessionRequestCompletionNotifyResult> {
  const candidate = completionNotificationCandidate(deps, input);
  if ("submitted" in candidate) return candidate;
  const sender = await completionNotificationSender(deps, candidate.fromSessionId);
  if ("submitted" in sender) return sender;
  const prompt = renderSessionRequestCompletionPrompt({
    mail: candidate.mail,
    targetSessionId: input.invocation.sessionId ?? candidate.mail.toSessionId,
    sourceInvocationId: input.invocation.invocationId,
    completion: input.completion,
  });
  const task = completionNotificationTask({ input, candidate, sender, prompt });
  if (!canAdmit(deps)) return skipped("admission_closed");
  const submitted = deps.invocationStore.submit({
    sessionId: candidate.fromSessionId,
    idempotencyKey: candidate.idempotencyKey,
    prompt,
    task,
    sourceKind: SESSION_REQUEST_COMPLETION_SOURCE_KIND,
    sourceRef: input.invocation.invocationId,
  });
  await deps.sessionRegistry.recordTurnQueued(candidate.fromSessionId);
  return { submitted: true, invocationId: submitted.invocationId };
}

function completionNotificationCandidate(
  deps: SessionRequestCompletionNotifyDependencies,
  input: {
    invocation: SparkInvocationRecord;
    task: SparkDaemonTask;
  },
): CompletionNotificationCandidate | SessionRequestCompletionNotifyResult {
  if (!canAdmit(deps)) return skipped("admission_closed");
  const mail = sessionMailFromTask(input.task);
  if (!mail) return skipped("no_session_mail");
  if (mail.notifyOnCompletion !== true) return skipped("notify_disabled");
  if (mail.kind !== "request") return skipped("not_request");
  const fromSessionId = trimmedString(mail.fromSessionId);
  if (!fromSessionId) return skipped("missing_from_session");
  if (fromSessionId === input.invocation.sessionId) return skipped("same_session");
  const idempotencyKey = `session.request.completion:${input.invocation.invocationId}`;
  if (deps.invocationStore.findByIdempotencyKey(idempotencyKey)) {
    return skipped("already_notified", input.invocation.invocationId);
  }
  return { mail, fromSessionId, idempotencyKey };
}

async function completionNotificationSender(
  deps: SessionRequestCompletionNotifyDependencies,
  fromSessionId: string,
): Promise<CompletionNotificationSender | SessionRequestCompletionNotifyResult> {
  const session = await deps.sessionRegistry.get(fromSessionId);
  if (!session) return skipped("sender_missing");
  if (session.status === "archived") return skipped("sender_archived");
  const cwd = sessionExecutionCwd(session, deps.resolveWorkspaceCwd);
  if (!cwd) return skipped("sender_cwd_unavailable");
  const model = deps.modelControl
    ? await deps.modelControl.effectiveModel(fromSessionId)
    : undefined;
  if (model) await deps.modelControl?.prepareModel(model);
  const thinkingLevel = deps.modelControl
    ? await deps.modelControl.effectiveThinkingLevel(fromSessionId)
    : undefined;
  return { session, cwd, model, thinkingLevel };
}

function completionNotificationTask(input: {
  input: {
    invocation: SparkInvocationRecord;
    completion: CompleteSparkInvocationInput;
  };
  candidate: CompletionNotificationCandidate;
  sender: CompletionNotificationSender;
  prompt: string;
}): SparkDaemonSessionRunTask {
  const { input: source, candidate, sender, prompt } = input;
  return {
    type: "session.run",
    sessionId: candidate.fromSessionId,
    prompt,
    cwd: sender.cwd,
    ...(sender.session.scope.kind === "workspace"
      ? { workspaceId: sender.session.scope.workspaceId }
      : {}),
    ...(sender.model ? { model: `${sender.model.providerName}/${sender.model.modelId}` } : {}),
    ...(sender.thinkingLevel ? { thinkingLevel: sender.thinkingLevel } : {}),
    actor: "spark-daemon-session-request-completion",
    messageMetadata: {
      origin: {
        kind: "system",
        host: "daemon",
        intent: SESSION_REQUEST_COMPLETION_SOURCE_KIND,
      },
      sessionRequestCompletion: {
        sourceInvocationId: source.invocation.invocationId,
        sourceSessionId: source.invocation.sessionId ?? candidate.mail.toSessionId,
        messageId: candidate.mail.messageId,
        correlationId: candidate.mail.correlationId,
        status: source.completion.status,
      },
    },
  };
}

function canAdmit(deps: SessionRequestCompletionNotifyDependencies): boolean {
  return deps.canAdmit?.() !== false;
}

function skipped(
  skippedReason: string,
  invocationId?: string,
): SessionRequestCompletionNotifyResult {
  return { submitted: false, skippedReason, ...(invocationId ? { invocationId } : {}) };
}

export function renderSessionRequestCompletionPrompt(input: {
  mail: SessionMailMetadata;
  targetSessionId: string | undefined;
  sourceInvocationId: string;
  completion: CompleteSparkInvocationInput;
}): string {
  const status = input.completion.status;
  const target = input.targetSessionId?.trim() || input.mail.toSessionId || "unknown";
  const summary = completionSummaryText(input.completion);
  return [
    "A delegated session request you sent has finished. Synthesize the result into your current work now.",
    `Target session: ${target}`,
    `Source invocation: ${input.sourceInvocationId}`,
    `Mail message: ${input.mail.messageId}`,
    `Status: ${status}`,
    ...(input.mail.correlationId ? [`Correlation: ${input.mail.correlationId}`] : []),
    ...(input.mail.intent ? [`Original intent: ${input.mail.intent}`] : []),
    "",
    "Completion summary:",
    summary,
    "",
    "Continue with the next concrete step. Do not claim the delegated work is still running.",
  ].join("\n");
}

interface SessionMailMetadata {
  messageId: string;
  kind?: string;
  intent?: string;
  correlationId?: string;
  fromSessionId?: string;
  toSessionId?: string;
  notifyOnCompletion?: boolean;
}

function sessionMailFromTask(task: SparkDaemonTask): SessionMailMetadata | undefined {
  if (!task || typeof task !== "object" || Array.isArray(task)) return undefined;
  const messageMetadata = (task as { messageMetadata?: unknown }).messageMetadata;
  if (!messageMetadata || typeof messageMetadata !== "object" || Array.isArray(messageMetadata)) {
    return undefined;
  }
  const mail = (messageMetadata as { sessionMail?: unknown }).sessionMail;
  if (!mail || typeof mail !== "object" || Array.isArray(mail)) return undefined;
  const record = mail as Record<string, unknown>;
  const messageId =
    typeof record.messageId === "string" && record.messageId.trim()
      ? record.messageId.trim()
      : undefined;
  if (!messageId) return undefined;
  return {
    messageId,
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    ...(typeof record.intent === "string" ? { intent: record.intent } : {}),
    ...(typeof record.correlationId === "string" ? { correlationId: record.correlationId } : {}),
    ...(typeof record.fromSessionId === "string" ? { fromSessionId: record.fromSessionId } : {}),
    ...(typeof record.toSessionId === "string" ? { toSessionId: record.toSessionId } : {}),
    ...(typeof record.notifyOnCompletion === "boolean"
      ? { notifyOnCompletion: record.notifyOnCompletion }
      : {}),
  };
}

function completionSummaryText(completion: CompleteSparkInvocationInput): string {
  if (completion.status === "succeeded") {
    const text = assistantTextFromResult(completion.result);
    return text?.trim() || "(no assistant text returned)";
  }
  if (completion.status === "cancelled") {
    return completion.cancelReason?.trim() || "cancelled";
  }
  const parts = [completion.errorCode?.trim(), completion.errorMessage?.trim() || "failed"].filter(
    Boolean,
  );
  return parts.join(": ");
}

function assistantTextFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const text = (result as { assistantText?: unknown }).assistantText;
  return typeof text === "string" ? text : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionExecutionCwd(
  session: SparkSessionRegistryRecord,
  resolveWorkspaceCwd: SessionRequestCompletionNotifyDependencies["resolveWorkspaceCwd"],
): string | undefined {
  const sessionCwd = session.cwd?.trim();
  if (sessionCwd && sessionCwd !== "/") return sessionCwd;
  if (session.scope.kind !== "workspace") return undefined;
  const workspaceCwd = resolveWorkspaceCwd?.(session.scope.workspaceId)?.trim();
  return workspaceCwd && workspaceCwd !== "/" ? workspaceCwd : undefined;
}
