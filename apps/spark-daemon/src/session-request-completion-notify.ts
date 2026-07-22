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
  if (deps.canAdmit?.() === false) {
    return { submitted: false, skippedReason: "admission_closed" };
  }
  const mail = sessionMailFromTask(input.task);
  if (!mail) return { submitted: false, skippedReason: "no_session_mail" };
  if (mail.notifyOnCompletion !== true) {
    return { submitted: false, skippedReason: "notify_disabled" };
  }
  if (mail.kind !== "request") {
    return { submitted: false, skippedReason: "not_request" };
  }
  const fromSessionId = mail.fromSessionId?.trim();
  if (!fromSessionId) return { submitted: false, skippedReason: "missing_from_session" };
  if (fromSessionId === input.invocation.sessionId) {
    return { submitted: false, skippedReason: "same_session" };
  }

  const idempotencyKey = `session.request.completion:${input.invocation.invocationId}`;
  if (deps.invocationStore.findByIdempotencyKey(idempotencyKey)) {
    return {
      submitted: false,
      skippedReason: "already_notified",
      invocationId: input.invocation.invocationId,
    };
  }

  const sender = await deps.sessionRegistry.get(fromSessionId);
  if (!sender) return { submitted: false, skippedReason: "sender_missing" };
  if (sender.status === "archived") return { submitted: false, skippedReason: "sender_archived" };

  const cwd = sessionExecutionCwd(sender, deps.resolveWorkspaceCwd);
  if (!cwd) return { submitted: false, skippedReason: "sender_cwd_unavailable" };

  const model = deps.modelControl
    ? await deps.modelControl.effectiveModel(fromSessionId)
    : undefined;
  if (model) await deps.modelControl?.prepareModel(model);
  const thinkingLevel = deps.modelControl
    ? await deps.modelControl.effectiveThinkingLevel(fromSessionId)
    : undefined;

  const prompt = renderSessionRequestCompletionPrompt({
    mail,
    targetSessionId: input.invocation.sessionId ?? mail.toSessionId,
    sourceInvocationId: input.invocation.invocationId,
    completion: input.completion,
  });

  const task: SparkDaemonSessionRunTask = {
    type: "session.run",
    sessionId: fromSessionId,
    prompt,
    cwd,
    ...(sender.scope.kind === "workspace" ? { workspaceId: sender.scope.workspaceId } : {}),
    ...(model ? { model: `${model.providerName}/${model.modelId}` } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    actor: "spark-daemon-session-request-completion",
    messageMetadata: {
      origin: {
        kind: "system",
        host: "daemon",
        intent: SESSION_REQUEST_COMPLETION_SOURCE_KIND,
      },
      sessionRequestCompletion: {
        sourceInvocationId: input.invocation.invocationId,
        sourceSessionId: input.invocation.sessionId ?? mail.toSessionId,
        messageId: mail.messageId,
        correlationId: mail.correlationId,
        status: input.completion.status,
      },
    },
  };

  if (deps.canAdmit?.() === false) {
    return { submitted: false, skippedReason: "admission_closed" };
  }

  const submitted = deps.invocationStore.submit({
    sessionId: fromSessionId,
    idempotencyKey,
    prompt,
    task,
    sourceKind: SESSION_REQUEST_COMPLETION_SOURCE_KIND,
    sourceRef: input.invocation.invocationId,
  });
  await deps.sessionRegistry.recordTurnQueued(fromSessionId);
  return { submitted: true, invocationId: submitted.invocationId };
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
  const lines = [
    "A delegated session request you sent has finished. Synthesize the result into your current work now.",
    `Target session: ${target}`,
    `Source invocation: ${input.sourceInvocationId}`,
    `Mail message: ${input.mail.messageId}`,
    `Status: ${status}`,
  ];
  if (input.mail.correlationId) lines.push(`Correlation: ${input.mail.correlationId}`);
  if (input.mail.intent) lines.push(`Original intent: ${input.mail.intent}`);
  lines.push("", "Completion summary:", summary);
  lines.push(
    "",
    "Continue with the next concrete step. Do not claim the delegated work is still running.",
  );
  return lines.join("\n");
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
