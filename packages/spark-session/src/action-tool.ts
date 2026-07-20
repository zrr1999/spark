import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  SparkSessionMailStore,
  sessionMailStatus,
  type SparkSessionMailKind,
  type SparkSessionMailMessage,
} from "./mail-store.ts";
import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  type SparkChannelAdapter,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  sparkTurnSubmitResultSchema,
  sparkTurnResultSchema,
  sparkTurnStatusResultSchema,
  type SparkSessionRegistryRecord,
  type SparkTurnSubmitResult,
  type SparkTurnResult,
  type SparkTurnStatusResult,
} from "@zendev-lab/spark-protocol";
import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-system/daemon-local-rpc";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const CHANNEL_ALLOWED_ACTIONS: ReadonlySet<SparkSessionAction> = new Set([
  "list",
  "get",
  "send",
  "inbox",
  "read",
  "ack",
]);

export type SparkSessionSurface = "local" | "channel";
export type SparkSessionActivity = "idle" | "running";

export type SparkSessionProjection = SparkSessionRegistryRecord & {
  surface: SparkSessionSurface;
  activity: SparkSessionActivity;
  channelAdapters: SparkChannelAdapter[];
  externalKeys: string[];
};

export type SparkSessionAction =
  | "list"
  | "get"
  | "create"
  | "call"
  | "bind"
  | "unbind"
  | "archive"
  | "send"
  | "inbox"
  | "read"
  | "ack";

export interface SparkSessionToolContext {
  cwd?: string;
  sessionId?: string;
  sparkStateRoot?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  channelBinding?: {
    adapter: SparkChannelAdapter;
    externalKey: string;
    adapterId?: string;
    adapterAccountIdentity?: string;
  };
  invocationId?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
  };
}

export interface SparkSessionActionDeps {
  request?: typeof requestSparkDaemonLocalRpc;
  mailStore?: (ctx: SparkSessionToolContext) => SparkSessionMailStore;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ExecuteSparkSessionActionInput {
  action: SparkSessionAction;
  toolCallId: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  ctx: SparkSessionToolContext;
}

export async function executeSparkSessionAction(
  input: ExecuteSparkSessionActionInput,
  deps: SparkSessionActionDeps = {},
) {
  const { action, params, signal, ctx } = input;
  const request = deps.request ?? requestSparkDaemonLocalRpc;
  assertChannelActionAllowed(action, ctx);
  const channelWorkspaceId = await currentChannelWorkspaceId(ctx, request, signal);

  switch (action) {
    case "list": {
      const requestParams = await listRequest(params, ctx, request, signal, channelWorkspaceId);
      const records = parseSparkSessionRegistryRecords(
        await request<unknown>("session.list", requestParams, { signal }),
      );
      const requestedSurface = normalizeSessionSurface(params.surface);
      const requestedActivity = normalizeSessionActivity(params.activity);
      const surface = requestedSurface;
      const adapter = normalizeChannelAdapter(params.adapter);
      const sessions = records
        .map(projectSession)
        .filter(
          (session) =>
            !channelWorkspaceId ||
            (session.scope.kind === "workspace" &&
              session.scope.workspaceId === channelWorkspaceId),
        )
        .filter((session) => !surface || session.surface === surface)
        .filter((session) => !requestedActivity || session.activity === requestedActivity)
        .filter((session) => !adapter || session.channelAdapters.includes(adapter));
      const limit = normalizeLimit(params.limit);
      const offset = normalizeOffset(params.offset);
      const visible = sessions.slice(offset, offset + limit);
      return sessionResult(renderSessionList(visible, sessions.length, offset), {
        action,
        sessions: visible,
        total: sessions.length,
        unfilteredTotal: records.length,
        limit,
        offset,
        surface: surface ?? "all",
        activity: requestedActivity ?? "all",
        adapter: adapter ?? null,
      });
    }
    case "get": {
      const sessionId = await targetSessionId(params.sessionId, ctx, "get");
      const record = await requestSession(request, sessionId, signal);
      if (channelWorkspaceId) {
        assertChannelWorkspaceTarget(record, channelWorkspaceId, "get");
      }
      const session = projectSession(record);
      return sessionResult(renderSession(session), { action, session });
    }
    case "create": {
      const createRequest = await sessionCreateRequest(params, ctx, request, signal);
      const session = projectSession(
        parseSparkSessionRegistryRecord(
          await request<unknown>("session.create", createRequest, { signal }),
        ),
      );
      return sessionResult(`Created persistent Spark session.\n${renderSession(session)}`, {
        action,
        session,
      });
    }
    case "call":
      return await executePersistentSessionCall({ params, signal, ctx }, deps);
    case "bind":
    case "unbind": {
      const sessionId = requiredString(params.sessionId, `session ${action} requires sessionId`);
      const externalKey = requiredString(
        params.externalKey,
        `session ${action} requires externalKey`,
      );
      const session = projectSession(
        parseSparkSessionRegistryRecord(
          await request<unknown>(`session.${action}`, { sessionId, externalKey }, { signal }),
        ),
      );
      return sessionResult(
        `${action === "bind" ? "Bound" : "Unbound"} persistent Spark session.\n${renderSession(session)}`,
        { action, session, externalKey },
      );
    }
    case "archive": {
      const sessionId = requiredString(params.sessionId, "session archive requires sessionId");
      const session = projectSession(
        parseSparkSessionRegistryRecord(
          await request<unknown>("session.archive", { sessionId }, { signal }),
        ),
      );
      return sessionResult(`Archived persistent Spark session.\n${renderSession(session)}`, {
        action,
        session,
      });
    }
    case "send": {
      const current = await requireCurrentSessionId(ctx, action);
      const toSessionId = requiredString(
        params.toSessionId ?? params.sessionId,
        "session send requires toSessionId",
      );
      if (toSessionId === current) throw new Error("session send must target a different session");
      const kind = normalizeMailKind(params.kind);
      const wait = normalizeSendWait(params.wait);
      if (kind === "notification" && wait === "completed") {
        throw new Error("session notification cannot wait for completion");
      }
      if (kind === "notification" && params.timeoutMs !== undefined) {
        throw new Error("session notification does not accept timeoutMs");
      }
      const timeoutMs =
        kind === "request" && wait === "completed"
          ? normalizeRequestTimeoutMs(params.timeoutMs)
          : undefined;
      if (kind === "request" && wait === "accepted" && params.timeoutMs !== undefined) {
        throw new Error("session request timeoutMs requires wait=completed");
      }
      const store = mailStoreForContext(ctx, deps);
      const intent =
        optionalString(params.intent, "intent") ??
        (kind === "request" ? "work.request" : "session.notification");
      if (!intent) throw new Error(`session ${action} requires intent`);
      const rawPayload = normalizePayload(params.payload);
      const message = optionalMessageBody(params.message);
      if (kind === "request" && !message) {
        throw new Error("session request requires a non-empty message body");
      }
      if (!message && Object.keys(rawPayload).length === 0) {
        throw new Error("session send requires message or a non-empty payload");
      }
      const payload =
        message && typeof rawPayload.text !== "string" && typeof rawPayload.body !== "string"
          ? { ...rawPayload, body: message }
          : rawPayload;
      const targetSession = await requestSession(request, toSessionId, signal);
      if (channelWorkspaceId) {
        assertChannelWorkspaceTarget(targetSession, channelWorkspaceId, action);
      }
      if (kind === "request" && targetSession.status === "archived") {
        throw new Error(`cannot request archived persistent session: ${toSessionId}`);
      }
      if (kind === "request" && projectSession(targetSession).surface !== "local") {
        throw new Error("session request targets must be local sessions");
      }
      const sent = await store.send({
        toSessionId,
        fromSessionId: current,
        kind,
        intent,
        payload,
        correlationId: optionalString(params.correlationId, "correlationId"),
        idempotencyKey: sessionSendIdempotencyKey({
          currentSessionId: current,
          toolCallId: input.toolCallId,
        }),
        subject: optionalString(params.subject, "subject"),
        body: message,
        ...(kind === "request" && ctx.sessionSurface === "channel" && ctx.channelBinding
          ? { originBinding: ctx.channelBinding }
          : {}),
        source: "tool",
      });
      if (kind === "notification") {
        return sessionResult(
          `Notified ${sent.message.id} for ${toSessionId}; the target session was not queued.`,
          {
            action,
            message: withMailStatus(sent.message),
            filePath: sent.path,
            created: sent.created,
            executionTriggered: false,
            blocking: false,
            wait,
            target: projectSession(targetSession),
          },
        );
      }
      let submitted: SparkTurnSubmitResult;
      try {
        submitted = parseTurnSubmitResult(
          await request<unknown>(
            "turn.submit",
            {
              sessionId: toSessionId,
              prompt: sent.message.body,
              idempotencyKey: `session.mail:${sent.message.id}`,
              messageMetadata: sessionRequestMessageMetadata({
                ctx,
                message: sent.message,
              }),
            },
            { signal },
          ),
        );
      } catch (error) {
        throw new Error(
          `session ${kind} stored ${sent.message.id} for ${toSessionId}, but invocation acceptance was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (wait === "completed") {
        const invocationId = submitted.invocationId;
        const completion = await waitForRequestResult({
          request,
          invocationId,
          timeoutMs: timeoutMs!,
          signal,
          sleep: deps.sleep,
          now: deps.now,
        });
        return completedRequestResult({
          action,
          sent,
          targetSession,
          submitted,
          invocationId,
          timeoutMs: timeoutMs!,
          completion,
        });
      }
      return sessionResult(
        `Sent asynchronous request ${sent.message.id} to ${toSessionId}; invocation ${submitted.invocationId} was accepted.`,
        {
          action,
          message: withMailStatus(sent.message),
          filePath: sent.path,
          created: sent.created,
          executionTriggered: true,
          blocking: false,
          wait,
          target: projectSession(targetSession),
          targetActivity: "running",
          submitted,
        },
      );
    }
    case "inbox": {
      const sessionId = await currentInboxSessionId(params.sessionId, ctx, "inbox");
      const includeAcked = optionalBoolean(params.includeAcked, false, "includeAcked");
      const limit = normalizeLimit(params.limit);
      const offset = normalizeOffset(params.offset);
      const allMessages = await mailStoreForContext(ctx, deps).list(sessionId, { includeAcked });
      const messages = allMessages.slice(offset, offset + limit).map((message) => ({
        ...withMailStatus(message),
        preview: previewMailBody(message.body),
      }));
      return sessionResult(renderInbox(sessionId, messages, allMessages.length, offset), {
        action,
        sessionId,
        messages,
        total: allMessages.length,
        limit,
        offset,
        includeAcked,
      });
    }
    case "read":
    case "ack": {
      const sessionId = await currentInboxSessionId(params.sessionId, ctx, action);
      const messageId = requiredString(params.messageId, `session ${action} requires messageId`);
      const store = mailStoreForContext(ctx, deps);
      const message =
        action === "read"
          ? await store.read(sessionId, messageId)
          : await store.ack(sessionId, messageId);
      const result = withMailStatus(message);
      return sessionResult(renderMailMessage(action, result), {
        action,
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
    ctx: SparkSessionToolContext;
  },
  deps: SparkSessionActionDeps = {},
) {
  if (input.ctx.sessionSurface === "channel") {
    throw new Error(
      "message-platform sessions cannot call another session directly; forward the request with session action=send",
    );
  }
  const request = deps.request ?? requestSparkDaemonLocalRpc;
  const sessionId = requiredString(input.params.sessionId, "session call requires sessionId");
  const instruction = requiredString(
    input.params.instruction,
    "session call instruction is required",
  );
  for (const field of [
    "timeoutMs",
    "cwd",
    "model",
    "role",
    "launch",
    "includeUser",
    "sessionDir",
    "piCommand",
  ]) {
    if (input.params[field] !== undefined) throw new Error(`session call does not accept ${field}`);
  }
  const reset = optionalBooleanValue(input.params.reset, "reset");
  const session = await requestSession(request, sessionId, input.signal);
  if (session.status === "archived")
    throw new Error(`cannot call archived persistent session: ${sessionId}`);
  const currentSessionId = await requireCurrentSessionId(input.ctx, "call");
  const submitted = parseTurnSubmitResult(
    await request<unknown>(
      "turn.submit",
      {
        sessionId,
        prompt: instruction,
        ...(reset === undefined ? {} : { reset }),
        messageMetadata: sessionOriginMessageMetadata(input.ctx, currentSessionId),
      },
      { signal: input.signal },
    ),
  );
  return sessionResult(
    `Queued persistent Spark session call: ${sessionId}; invocation ${submitted.invocationId} was accepted.`,
    {
      action: "call",
      session: projectSession(session),
      sessionId,
      sessionPersistence: "persistent",
      submitted,
    },
  );
}

async function listRequest(
  params: Record<string, unknown>,
  ctx: SparkSessionToolContext,
  request: typeof requestSparkDaemonLocalRpc,
  signal: AbortSignal,
  channelWorkspaceId?: string,
): Promise<SparkSessionListRequest> {
  const includeArchived = optionalBoolean(params.includeArchived, false, "includeArchived");
  const workspaceId = optionalString(params.workspaceId, "workspaceId");
  const scope = optionalScope(params.scope);
  if (channelWorkspaceId) {
    if (scope === "daemon" || (workspaceId && workspaceId !== channelWorkspaceId)) {
      throw new Error("message-platform sessions can list sessions in their own workspace only");
    }
    return {
      scope: { kind: "workspace", workspaceId: channelWorkspaceId },
      workspaceId: channelWorkspaceId,
      includeArchived,
    };
  }
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
  ctx: SparkSessionToolContext,
  request: typeof requestSparkDaemonLocalRpc,
  signal: AbortSignal,
): Promise<SparkSessionCreateRequest> {
  const scope = optionalScope(params.scope) ?? "workspace";
  const sessionId = optionalString(params.sessionId, "sessionId");
  if (params.title !== undefined) {
    throw new Error("session create names persistent sessions by role; use role instead of title");
  }
  const role = requiredString(
    params.role,
    "session create requires role as a stable division of labour",
  );
  const cwd = optionalString(params.cwd, "cwd") ?? ctx.cwd;
  const common = {
    ...(sessionId ? { sessionId } : {}),
    title: role,
    role,
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
  ctx: SparkSessionToolContext,
  request: typeof requestSparkDaemonLocalRpc,
  signal: AbortSignal,
): Promise<string> {
  const cwd = requiredString(ctx.cwd, "session action requires ctx.cwd");
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

function assertChannelActionAllowed(
  action: SparkSessionAction,
  ctx: SparkSessionToolContext,
): void {
  if (ctx.sessionSurface !== "channel" || CHANNEL_ALLOWED_ACTIONS.has(action)) return;
  throw new Error(
    `message-platform sessions cannot use session action=${action}; delegate work with session action=send and kind=request`,
  );
}

async function currentChannelWorkspaceId(
  ctx: SparkSessionToolContext,
  request: typeof requestSparkDaemonLocalRpc,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (ctx.sessionSurface !== "channel") return undefined;
  const sessionId = await requireCurrentSessionId(ctx, "workspace scope");
  const current = await requestSession(request, sessionId, signal);
  if (current.scope.kind !== "workspace") {
    throw new Error("message-platform sessions require a workspace-scoped current session");
  }
  return current.scope.workspaceId;
}

function assertChannelWorkspaceTarget(
  target: SparkSessionRegistryRecord,
  workspaceId: string,
  action: "get" | "send",
): void {
  if (target.scope.kind !== "workspace" || target.scope.workspaceId !== workspaceId) {
    throw new Error(
      `message-platform session ${action} targets must be sessions in the current workspace`,
    );
  }
}

function mailStoreForContext(
  ctx: SparkSessionToolContext,
  deps: SparkSessionActionDeps,
): SparkSessionMailStore {
  return (
    deps.mailStore?.(ctx) ??
    new SparkSessionMailStore(ctx.sparkStateRoot ? { sparkHome: ctx.sparkStateRoot } : undefined)
  );
}

async function targetSessionId(
  value: unknown,
  ctx: SparkSessionToolContext,
  action: "get",
): Promise<string> {
  const target = optionalString(value, "sessionId") ?? (await currentSessionId(ctx));
  if (!target)
    throw new Error(`session ${action} requires sessionId when no current session exists`);
  return target;
}

async function currentInboxSessionId(
  value: unknown,
  ctx: SparkSessionToolContext,
  action: "inbox" | "read" | "ack",
): Promise<string> {
  const current = await requireCurrentSessionId(ctx, action);
  const requested = optionalString(value, "sessionId");
  if (requested && requested !== current) {
    throw new Error(
      `session ${action} only supports the current session inbox (${current}); another session's inbox is private`,
    );
  }
  return current;
}

async function requireCurrentSessionId(
  ctx: SparkSessionToolContext,
  action: string,
): Promise<string> {
  const current = await currentSessionId(ctx);
  if (!current) throw new Error(`session ${action} requires a current persistent session`);
  return current;
}

async function currentSessionId(ctx: SparkSessionToolContext): Promise<string | undefined> {
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

function normalizeMailKind(value: unknown): SparkSessionMailKind {
  if (value === undefined || value === null || value === "") return "notification";
  if (value !== "request" && value !== "notification") {
    throw new Error("session kind must be request or notification");
  }
  return value;
}

function normalizeSendWait(value: unknown): "accepted" | "completed" {
  if (value === undefined || value === null || value === "") return "accepted";
  if (value !== "accepted" && value !== "completed") {
    throw new Error("session wait must be accepted or completed");
  }
  return value;
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("session payload must be a JSON object");
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("payload is not JSON-serializable");
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed)) throw new Error("payload must serialize to a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(
      `session payload must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sessionSendIdempotencyKey(input: {
  currentSessionId: string;
  toolCallId: string;
}): string {
  return `session.tool:${JSON.stringify([input.currentSessionId, input.toolCallId])}`;
}

function normalizeSessionSurface(value: unknown): SparkSessionSurface | undefined {
  if (value === undefined || value === null || value === "" || value === "all") return undefined;
  if (value === "local" || value === "channel") return value;
  throw new Error("session surface must be all, local, or channel");
}

function normalizeSessionActivity(value: unknown): SparkSessionActivity | undefined {
  if (value === undefined || value === null || value === "" || value === "all") return undefined;
  if (value === "idle" || value === "running") return value;
  throw new Error("session activity must be all, idle, or running");
}

function normalizeChannelAdapter(value: unknown): SparkChannelAdapter | undefined {
  if (value === undefined || value === null || value === "" || value === "all") return undefined;
  if (value === "feishu" || value === "infoflow" || value === "qqbot") return value;
  throw new Error("session adapter must be all, feishu, infoflow, or qqbot");
}

function optionalScope(value: unknown): "workspace" | "daemon" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "workspace" || value === "daemon") return value;
  throw new Error("session scope must be workspace or daemon");
}

function normalizeOffset(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
    throw new Error("session offset must be a finite integer");
  if (value < 0) throw new Error("session offset must be non-negative");
  return value;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
    throw new Error("session limit must be a finite integer");
  if (value < 1 || value > MAX_LIMIT)
    throw new Error(`session limit must be between 1 and ${MAX_LIMIT}`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  return optionalBooleanValue(value, field) ?? fallback;
}

function optionalBooleanValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`session ${field} must be a boolean`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`session ${field} must be a string`);
  return value.trim() || undefined;
}

function optionalMessageBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("session message must be a string");
  return value.trim() ? value : undefined;
}

function requiredString(value: unknown, message: string): string {
  const result = optionalString(value, "value");
  if (!result) throw new Error(message);
  return result;
}

function projectSession(session: SparkSessionRegistryRecord): SparkSessionProjection {
  const channelAdapters = Array.from(new Set(session.bindings.map((binding) => binding.adapter)));
  return {
    ...session,
    surface: channelAdapters.length > 0 ? "channel" : "local",
    activity: session.status === "running" ? "running" : "idle",
    channelAdapters,
    externalKeys: session.bindings.map((binding) => binding.externalKey),
  };
}

function renderSessionList(
  sessions: SparkSessionProjection[],
  total: number,
  offset: number,
): string {
  if (sessions.length === 0) {
    return total > 0
      ? `No sessions at offset ${offset}; remaining=0. Use session list with a lower offset.`
      : "No persistent Spark sessions found.";
  }
  const end = offset + sessions.length;
  const remaining = Math.max(0, total - end);
  const page = `Persistent Spark sessions (${offset + 1}-${end}/${total}):\n${sessions
    .map(renderSession)
    .join("\n")}`;
  return `${page}\nnext offset=${remaining > 0 ? end : "none"}; remaining=${remaining}; use session get for details.`;
}

function renderSession(session: SparkSessionProjection): string {
  const scope =
    session.scope.kind === "workspace"
      ? `workspace:${session.scope.workspaceId}`
      : `daemon:${session.scope.daemonId}`;
  const channels = session.channelAdapters.join(",") || "none";
  return `${session.sessionId} ${session.status} activity=${session.activity} surface=${session.surface} channels=${channels} scope=${scope}${
    session.role
      ? ` role=${JSON.stringify(session.role)}`
      : session.title
        ? ` role=${JSON.stringify(session.title)}`
        : ""
  }`;
}

function withMailStatus(message: SparkSessionMailMessage) {
  return { ...message, status: sessionMailStatus(message) };
}

function renderInbox(
  sessionId: string,
  messages: Array<ReturnType<typeof withMailStatus> & { preview: string }>,
  total: number,
  offset: number,
): string {
  if (messages.length === 0) {
    return total > 0
      ? `No mail at offset ${offset} for ${sessionId}; remaining=0. Use inbox with a lower offset.`
      : `No Spark session mail for ${sessionId}.`;
  }
  const end = offset + messages.length;
  const remaining = Math.max(0, total - end);
  const page = `Spark session inbox for ${sessionId} (${offset + 1}-${end}/${total}):\n${messages
    .map(
      (message) =>
        `${message.id} ${message.status} from=${message.fromSessionId} ${message.createdAt} ${message.preview}`,
    )
    .join("\n")}`;
  return `${page}\nnext offset=${remaining > 0 ? end : "none"}; remaining=${remaining}; use session read for full message details.`;
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

function sessionOriginMessageMetadata(
  ctx: SparkSessionToolContext,
  sessionId: string,
): Record<string, unknown> {
  return {
    origin: {
      kind: "session",
      sessionId,
      surface: ctx.sessionSurface ?? "local",
      host: ctx.sessionSource ?? (ctx.sessionSurface === "channel" ? "channel" : "session"),
    },
  };
}

function sessionRequestMessageMetadata(input: {
  ctx: SparkSessionToolContext;
  message: SparkSessionMailMessage;
}): Record<string, unknown> {
  return {
    ...sessionOriginMessageMetadata(input.ctx, input.message.fromSessionId),
    sessionMail: {
      messageId: input.message.id,
      kind: input.message.kind,
      intent: input.message.intent,
      correlationId: input.message.correlationId,
      fromSessionId: input.message.fromSessionId,
      toSessionId: input.message.toSessionId,
      ...(input.ctx.invocationId ? { parentInvocationId: input.ctx.invocationId } : {}),
    },
  };
}

function normalizeRequestTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("session request timeoutMs must be a finite integer");
  }
  if (value < MIN_REQUEST_TIMEOUT_MS || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `session request timeoutMs must be between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  return value;
}

function parseTurnSubmitResult(value: unknown): SparkTurnSubmitResult {
  const parsed = sparkTurnSubmitResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Spark daemon returned an invalid turn.submit receipt");
  }
  return parsed.data;
}

type RequestCompletion =
  | { timedOut: true; status: SparkTurnStatusResult }
  | { timedOut: false; status: SparkTurnStatusResult; result: SparkTurnResult };

async function waitForRequestResult(input: {
  request: typeof requestSparkDaemonLocalRpc;
  invocationId: string;
  timeoutMs: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}): Promise<RequestCompletion> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.timeoutMs;
  let status: SparkTurnStatusResult | undefined;
  while (true) {
    status = sparkTurnStatusResultSchema.parse(
      await input.request<unknown>(
        "turn.status",
        { invocationId: input.invocationId },
        { signal: input.signal },
      ),
    );
    if (isTerminalStatus(status.status)) {
      const result = sparkTurnResultSchema.parse(
        await input.request<unknown>(
          "turn.result",
          { invocationId: input.invocationId },
          { signal: input.signal },
        ),
      );
      return { timedOut: false, status, result };
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { timedOut: true, status };
    const waitMs = Math.min(250, remainingMs);
    if (input.sleep) await input.sleep(waitMs, input.signal);
    else await delay(waitMs, undefined, { signal: input.signal });
  }
}

function completedRequestResult(input: {
  action: "send";
  sent: Awaited<ReturnType<SparkSessionMailStore["send"]>>;
  targetSession: SparkSessionRegistryRecord;
  submitted: SparkTurnSubmitResult;
  invocationId: string;
  timeoutMs: number;
  completion: RequestCompletion;
}) {
  const common = {
    action: input.action,
    message: withMailStatus(input.sent.message),
    filePath: input.sent.path,
    created: input.sent.created,
    executionTriggered: true,
    blocking: true,
    target: projectSession(input.targetSession),
    invocationId: input.invocationId,
    timeoutMs: input.timeoutMs,
    submitted: input.submitted,
  };
  if (input.completion.timedOut) {
    return sessionResult(
      `Request ${input.sent.message.id} is still ${input.completion.status.status}; stopped waiting after ${input.timeoutMs}ms. Invocation ${input.invocationId} continues asynchronously.`,
      {
        ...common,
        waitTimedOut: true,
        targetActivity: "running",
        status: input.completion.status,
      },
    );
  }
  const { result, status } = input.completion;
  if (result.status === "succeeded") {
    const answer = result.assistantText ?? "";
    return sessionResult(
      answer || `Request completed without a textual response (${input.invocationId}).`,
      {
        ...common,
        waitTimedOut: false,
        targetActivity: "idle",
        status,
        result,
        answer,
      },
    );
  }
  const error = result.error?.message ?? status.cancelReason ?? `request ${result.status}`;
  return sessionResult(`Request ${input.invocationId} ${result.status}: ${error}`, {
    ...common,
    waitTimedOut: false,
    targetActivity: "idle",
    status,
    result,
  });
}

function isTerminalStatus(status: SparkTurnStatusResult["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
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
