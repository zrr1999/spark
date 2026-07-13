import { readFile } from "node:fs/promises";
import {
  SparkSessionMailStore,
  sessionMailStatus,
  type SparkSessionMailKind,
  type SparkSessionMailMessage,
} from "@zendev-lab/spark-session";
import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
} from "@zendev-lab/spark-protocol";
import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-system/daemon-local-rpc";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type RoleSessionAction =
  | "list"
  | "get"
  | "create"
  | "bind"
  | "unbind"
  | "archive"
  | "send"
  | "mailto"
  | "inbox"
  | "read"
  | "ack";

export interface RoleSessionContext {
  cwd?: string;
  sessionId?: string;
  sparkStateRoot?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
  };
}

export interface RoleSessionActionDeps {
  request?: typeof requestSparkDaemonLocalRpc;
  mailStore?: (ctx: RoleSessionContext) => SparkSessionMailStore;
}

export interface ExecuteRoleSessionActionInput {
  action: RoleSessionAction;
  toolCallId: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  ctx: RoleSessionContext;
}

export async function executeRoleSessionAction(
  input: ExecuteRoleSessionActionInput,
  deps: RoleSessionActionDeps = {},
) {
  const { action, params, signal, ctx } = input;
  const request = deps.request ?? requestSparkDaemonLocalRpc;

  switch (action) {
    case "list": {
      const requestParams = await listRequest(params, ctx, request, signal);
      const sessions = parseSparkSessionRegistryRecords(
        await request<unknown>("session.list", requestParams, { signal }),
      );
      const limit = normalizeLimit(params.limit);
      const visible = sessions.slice(0, limit);
      return sessionResult(renderSessionList(visible, sessions.length), {
        action,
        resource: "session",
        sessions: visible,
        total: sessions.length,
        limit,
      });
    }
    case "get": {
      const sessionId = await targetSessionId(params.sessionId, ctx, "get");
      const session = await requestSession(request, sessionId, signal);
      return sessionResult(renderSession(session), { action, resource: "session", session });
    }
    case "create": {
      const createRequest = await sessionCreateRequest(params, ctx, request, signal);
      const session = parseSparkSessionRegistryRecord(
        await request<unknown>("session.create", createRequest, { signal }),
      );
      return sessionResult(`Created persistent Spark session.\n${renderSession(session)}`, {
        action,
        resource: "session",
        session,
      });
    }
    case "bind":
    case "unbind": {
      const sessionId = requiredString(params.sessionId, `role ${action} requires sessionId`);
      const externalKey = requiredString(params.externalKey, `role ${action} requires externalKey`);
      const session = parseSparkSessionRegistryRecord(
        await request<unknown>(`session.${action}`, { sessionId, externalKey }, { signal }),
      );
      return sessionResult(
        `${action === "bind" ? "Bound" : "Unbound"} persistent Spark session.\n${renderSession(session)}`,
        { action, resource: "session", session, externalKey },
      );
    }
    case "archive": {
      const sessionId = requiredString(params.sessionId, "role archive requires sessionId");
      const session = parseSparkSessionRegistryRecord(
        await request<unknown>("session.archive", { sessionId }, { signal }),
      );
      return sessionResult(`Archived persistent Spark session.\n${renderSession(session)}`, {
        action,
        resource: "session",
        session,
      });
    }
    case "send":
    case "mailto": {
      const current = await requireCurrentSessionId(ctx, action);
      const store = mailStoreForContext(ctx, deps);
      const replyToMessageId = optionalString(params.replyToMessageId, "replyToMessageId");
      const original = replyToMessageId ? await store.get(current, replyToMessageId) : undefined;
      const requestedTarget = optionalString(params.toSessionId ?? params.sessionId, "toSessionId");
      const toSessionId = resolveSendTarget({
        currentSessionId: current,
        requestedTarget,
        original,
      });
      const kind = normalizeMailKind(params.kind, action, Boolean(replyToMessageId));
      validateCausalSend({ currentSessionId: current, kind, original });
      const intent =
        optionalString(params.intent, "intent") ??
        (action === "mailto" ? "session.mail" : undefined);
      if (!intent) throw new Error("role send requires intent");
      const rawPayload = normalizePayload(params.payload);
      const message = optionalString(params.message, "message");
      if (!message && Object.keys(rawPayload).length === 0)
        throw new Error("role send requires message or a non-empty payload");
      const payload =
        message && typeof rawPayload.text !== "string" && typeof rawPayload.body !== "string"
          ? { ...rawPayload, body: message }
          : rawPayload;
      await requestSession(request, toSessionId, signal);
      const requestedCorrelationId = optionalString(params.correlationId, "correlationId");
      const correlationId = original?.correlationId ?? requestedCorrelationId;
      if (original && requestedCorrelationId && requestedCorrelationId !== original.correlationId) {
        throw new Error(
          `role send correlationId must match the original request ${original.correlationId}`,
        );
      }
      const sent = await store.send({
        toSessionId,
        fromSessionId: current,
        kind,
        intent,
        payload,
        correlationId,
        replyToMessageId,
        idempotencyKey: sessionSendIdempotencyKey({
          currentSessionId: current,
          toolCallId: input.toolCallId,
          kind,
          intent,
          payload,
          replyToMessageId,
        }),
        subject: optionalString(params.subject, "subject"),
        body: message,
        source: "tool",
      });
      return sessionResult(
        `${sent.created ? "Sent" : "Reused"} ${sent.message.id} to ${sent.message.toSessionId}. The target session was not executed or queued; do not poll for a reply.`,
        {
          action: action === "mailto" ? "send" : action,
          compatibilityAction: action === "mailto" ? "mailto" : undefined,
          resource: "session",
          message: withMailStatus(sent.message),
          filePath: sent.path,
          created: sent.created,
          autoExecuted: false,
        },
      );
    }
    case "inbox": {
      const sessionId = await currentInboxSessionId(params.sessionId, ctx, "inbox");
      const includeAcked = optionalBoolean(params.includeAcked, false, "includeAcked");
      const limit = normalizeLimit(params.limit);
      const allMessages = await mailStoreForContext(ctx, deps).list(sessionId, { includeAcked });
      const messages = allMessages.slice(0, limit).map((message) => ({
        ...withMailStatus(message),
        preview: previewMailBody(message.body),
      }));
      return sessionResult(renderInbox(sessionId, messages, allMessages.length), {
        action,
        resource: "session",
        sessionId,
        messages,
        total: allMessages.length,
        limit,
        includeAcked,
      });
    }
    case "read":
    case "ack": {
      const sessionId = await currentInboxSessionId(params.sessionId, ctx, action);
      const messageId = requiredString(params.messageId, `role ${action} requires messageId`);
      const store = mailStoreForContext(ctx, deps);
      const message =
        action === "read"
          ? await store.read(sessionId, messageId)
          : await store.ack(sessionId, messageId);
      const result = withMailStatus(message);
      return sessionResult(renderMailMessage(action, result), {
        action,
        resource: "session",
        sessionId,
        message: result,
      });
    }
  }
}

export async function executePersistentSessionCall(
  input: {
    params: Record<string, unknown>;
    signal: AbortSignal;
    ctx: RoleSessionContext;
  },
  deps: RoleSessionActionDeps = {},
) {
  const request = deps.request ?? requestSparkDaemonLocalRpc;
  const sessionId = requiredString(input.params.sessionId, "role call requires sessionId or role");
  const instruction = requiredString(input.params.instruction, "role call instruction is required");
  if (optionalString(input.params.role, "role"))
    throw new Error(
      "role call accepts either role for an anonymous call or sessionId for a persistent call, not both",
    );
  if (input.params.launch !== undefined || input.params.forkFromSession !== undefined)
    throw new Error("persistent role call does not accept launch or forkFromSession");
  if (input.params.model !== undefined)
    throw new Error(
      "persistent role call uses the session model; change it through session model control",
    );
  for (const field of ["cwd", "timeoutMs", "includeUser", "sessionDir", "piCommand"]) {
    if (input.params[field] !== undefined)
      throw new Error(`persistent role call does not accept ${field}`);
  }
  const reset = optionalBooleanValue(input.params.reset, "reset");
  const session = await requestSession(request, sessionId, input.signal);
  if (session.status === "archived")
    throw new Error(`cannot call archived persistent session: ${sessionId}`);
  const submitted = await request<unknown>(
    "turn.submit",
    {
      sessionId,
      prompt: instruction,
      ...(reset === undefined ? {} : { reset }),
    },
    { signal: input.signal },
  );
  const fileName =
    isRecord(submitted) && typeof submitted.fileName === "string" ? submitted.fileName : undefined;
  return sessionResult(
    `Queued persistent Spark session call: ${sessionId}${fileName ? ` (${fileName})` : ""}.`,
    {
      action: "call",
      resource: "session",
      session,
      sessionId,
      sessionPersistence: "persistent",
      submitted,
    },
  );
}

async function listRequest(
  params: Record<string, unknown>,
  ctx: RoleSessionContext,
  request: typeof requestSparkDaemonLocalRpc,
  signal: AbortSignal,
): Promise<SparkSessionListRequest> {
  const includeArchived = optionalBoolean(params.includeArchived, false, "includeArchived");
  const workspaceId = optionalString(params.workspaceId, "workspaceId");
  const scope = optionalScope(params.scope);
  if (scope === "daemon") return { scope: { kind: "daemon" }, includeArchived };
  if (workspaceId)
    return {
      scope: { kind: "workspace", workspaceId },
      workspaceId,
      includeArchived,
    };
  if (scope === "workspace") {
    const resolvedWorkspaceId = await currentWorkspaceId(ctx, request, signal);
    return {
      scope: { kind: "workspace", workspaceId: resolvedWorkspaceId },
      workspaceId: resolvedWorkspaceId,
      includeArchived,
    };
  }
  return { includeArchived };
}

async function sessionCreateRequest(
  params: Record<string, unknown>,
  ctx: RoleSessionContext,
  request: typeof requestSparkDaemonLocalRpc,
  signal: AbortSignal,
): Promise<SparkSessionCreateRequest> {
  const scope = optionalScope(params.scope) ?? "workspace";
  const sessionId = optionalString(params.sessionId, "sessionId");
  const title = optionalString(params.title, "title");
  const role = optionalString(params.role, "role");
  const cwd = optionalString(params.cwd, "cwd") ?? ctx.cwd;
  const common = {
    ...(sessionId ? { sessionId } : {}),
    ...(title ? { title } : {}),
    ...(role ? { role } : {}),
    ...(cwd ? { cwd } : {}),
  };
  if (scope === "daemon") return { ...common, scope: { kind: "daemon" } };
  const workspaceId =
    optionalString(params.workspaceId, "workspaceId") ??
    (await currentWorkspaceId(ctx, request, signal));
  return {
    ...common,
    scope: { kind: "workspace", workspaceId },
    workspaceId,
  };
}

async function currentWorkspaceId(
  ctx: RoleSessionContext,
  request: typeof requestSparkDaemonLocalRpc,
  signal: AbortSignal,
): Promise<string> {
  const cwd = requiredString(ctx.cwd, "role session action requires ctx.cwd");
  const result = await request<unknown>("workspace.ensure-local", { localPath: cwd }, { signal });
  if (!isRecord(result) || typeof result.id !== "string" || !result.id.trim())
    throw new Error("Spark daemon returned an invalid workspace.ensure-local result");
  return result.id.trim();
}

async function requestSession(
  request: typeof requestSparkDaemonLocalRpc,
  sessionId: string,
  signal: AbortSignal,
): Promise<SparkSessionRegistryRecord> {
  return parseSparkSessionRegistryRecord(
    await request<unknown>("session.get", { sessionId }, { signal }),
  );
}

function mailStoreForContext(
  ctx: RoleSessionContext,
  deps: RoleSessionActionDeps,
): SparkSessionMailStore {
  return (
    deps.mailStore?.(ctx) ??
    new SparkSessionMailStore(ctx.sparkStateRoot ? { sparkHome: ctx.sparkStateRoot } : undefined)
  );
}

async function targetSessionId(
  value: unknown,
  ctx: RoleSessionContext,
  action: "get",
): Promise<string> {
  const target = optionalString(value, "sessionId") ?? (await currentSessionId(ctx));
  if (!target) throw new Error(`role ${action} requires sessionId when no current session exists`);
  return target;
}

async function currentInboxSessionId(
  value: unknown,
  ctx: RoleSessionContext,
  action: "inbox" | "read" | "ack",
): Promise<string> {
  const current = await requireCurrentSessionId(ctx, action);
  const requested = optionalString(value, "sessionId");
  if (requested && requested !== current) {
    throw new Error(
      `role ${action} only supports the current session inbox (${current}); another session's inbox is private`,
    );
  }
  return current;
}

async function requireCurrentSessionId(ctx: RoleSessionContext, action: string): Promise<string> {
  const current = await currentSessionId(ctx);
  if (!current) throw new Error(`role ${action} requires a current persistent session`);
  return current;
}

async function currentSessionId(ctx: RoleSessionContext): Promise<string | undefined> {
  const direct = ctx.sessionId?.trim();
  if (direct) return direct;
  const path = ctx.sessionManager?.getSessionFile?.()?.trim();
  if (!path) return undefined;
  try {
    const firstLine = (await readFile(path, "utf8")).split("\n", 1)[0];
    if (firstLine) {
      const header = JSON.parse(firstLine) as unknown;
      if (isRecord(header) && typeof header.id === "string" && header.id.trim())
        return header.id.trim();
    }
  } catch {
    // The host may expose a future session path before the file is persisted.
  }
  const fileName =
    path
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.jsonl?$/u, "") ?? "";
  const match = fileName.match(/(?:^|_)([0-9a-f]{8}-[0-9a-f-]{27,})$/iu);
  return match?.[1];
}

function resolveSendTarget(input: {
  currentSessionId: string;
  requestedTarget?: string;
  original?: SparkSessionMailMessage;
}): string {
  const causalTarget = input.original?.fromSessionId;
  if (causalTarget && input.requestedTarget && input.requestedTarget !== causalTarget) {
    throw new Error(
      `role send target ${input.requestedTarget} does not match original sender ${causalTarget}`,
    );
  }
  const target = causalTarget ?? input.requestedTarget;
  if (!target)
    throw new Error("role send requires toSessionId unless replyToMessageId is provided");
  if (target === input.currentSessionId)
    throw new Error("role send must target a different session");
  return target;
}

function validateCausalSend(input: {
  currentSessionId: string;
  kind: SparkSessionMailKind;
  original?: SparkSessionMailMessage;
}): void {
  if (!input.original) {
    if (input.kind === "reply") throw new Error("role reply requires replyToMessageId");
    return;
  }
  if (input.original.toSessionId !== input.currentSessionId) {
    throw new Error(
      `session mail ${input.original.id} is addressed to ${input.original.toSessionId}, not ${input.currentSessionId}`,
    );
  }
  if (input.original.kind !== "request")
    throw new Error(`session mail ${input.original.id} is not a request`);
  if (input.kind === "request")
    throw new Error("a causal response must use reply or inform, not request");
}

function normalizeMailKind(
  value: unknown,
  action: "send" | "mailto",
  hasReplyTo: boolean,
): SparkSessionMailKind {
  if (value === undefined || value === null || value === "") {
    if (hasReplyTo) return "reply";
    return action === "mailto" ? "inform" : "request";
  }
  if (value === "request" || value === "inform" || value === "reply") return value;
  throw new Error("role kind must be request, inform, or reply");
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("role payload must be a JSON object");
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("payload is not JSON-serializable");
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed)) throw new Error("payload must serialize to a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(
      `role payload must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sessionSendIdempotencyKey(input: {
  currentSessionId: string;
  toolCallId: string;
  kind: SparkSessionMailKind;
  intent: string;
  payload: Record<string, unknown>;
  replyToMessageId?: string;
}): string {
  if (!input.replyToMessageId)
    return `session.tool:${JSON.stringify([input.currentSessionId, input.toolCallId])}`;
  if (input.kind === "reply")
    return `session.reply:${JSON.stringify([input.currentSessionId, input.replyToMessageId])}`;
  return `session.causal:${JSON.stringify([
    input.currentSessionId,
    input.replyToMessageId,
    input.kind,
    input.intent,
    input.payload,
  ])}`;
}

function optionalScope(value: unknown): "workspace" | "daemon" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "workspace" || value === "daemon") return value;
  throw new Error("role session scope must be workspace or daemon");
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
    throw new Error("role session limit must be a finite integer");
  if (value < 1 || value > MAX_LIMIT)
    throw new Error(`role session limit must be between 1 and ${MAX_LIMIT}`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  return optionalBooleanValue(value, field) ?? fallback;
}

function optionalBooleanValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`role ${field} must be a boolean`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`role ${field} must be a string`);
  return value.trim() || undefined;
}

function requiredString(value: unknown, message: string): string {
  const result = optionalString(value, "value");
  if (!result) throw new Error(message);
  return result;
}

function renderSessionList(sessions: SparkSessionRegistryRecord[], total: number): string {
  if (sessions.length === 0) return "No persistent Spark sessions found.";
  const suffix = total > sessions.length ? `\n… ${total - sessions.length} more session(s)` : "";
  return `Persistent Spark sessions (${sessions.length}/${total}):\n${sessions
    .map(renderSession)
    .join("\n")}${suffix}`;
}

function renderSession(session: SparkSessionRegistryRecord): string {
  const scope =
    session.scope.kind === "workspace"
      ? `workspace:${session.scope.workspaceId}`
      : `daemon:${session.scope.daemonId}`;
  const bindings = session.bindings.map((binding) => binding.externalKey).join(", ") || "none";
  return `${session.sessionId} ${session.status} scope=${scope} bindings=${bindings}${
    session.title ? ` title=${JSON.stringify(session.title)}` : ""
  }`;
}

function withMailStatus(message: SparkSessionMailMessage) {
  return { ...message, status: sessionMailStatus(message) };
}

function renderInbox(
  sessionId: string,
  messages: Array<ReturnType<typeof withMailStatus> & { preview: string }>,
  total: number,
): string {
  if (messages.length === 0) return `No Spark session mail for ${sessionId}.`;
  const suffix = total > messages.length ? `\n… ${total - messages.length} more message(s)` : "";
  return `Spark session inbox for ${sessionId} (${messages.length}/${total}):\n${messages
    .map(
      (message) =>
        `${message.id} ${message.status} from=${message.fromSessionId} ${message.createdAt} ${message.preview}`,
    )
    .join("\n")}${suffix}`;
}

function renderMailMessage(
  action: "read" | "ack",
  message: ReturnType<typeof withMailStatus>,
): string {
  return [
    `${action === "ack" ? "Acknowledged" : "Read"} ${message.id}`,
    `to=${message.toSessionId}`,
    `from=${message.fromSessionId}`,
    `status=${message.status}`,
    `subject=${message.subject ?? ""}`,
    "",
    message.body,
  ].join("\n");
}

function previewMailBody(body: string): string {
  const oneLine = body.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

function sessionResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
