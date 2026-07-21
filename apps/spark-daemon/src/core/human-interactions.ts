import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  createId,
  parseSparkInteractionRequest,
  sparkJsonObjectSchema,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
} from "@zendev-lab/spark-protocol";
import { runtimeEnvelope } from "../protocol/outbound.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitDeliveryResult,
  type SparkDaemonHumanWaitRecord,
} from "./human-waits.ts";

export interface SparkDaemonHumanInteractionContext {
  sessionId: string;
  invocationId: string;
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
  channel?: {
    workspaceId: string;
    adapterId: string;
    recipient: string;
    actorId?: string;
    messageId?: string;
  };
}

export interface SparkDaemonHumanInteractionOpened {
  wait: SparkDaemonHumanWaitRecord;
  /** Channel / keyboard projection always receives an ask-shaped request. */
  request: Extract<SparkInteractionRequest, { kind: "askFlow" }>;
  channel?: SparkDaemonHumanInteractionContext["channel"];
  callbackOptions: Array<{
    token: string;
    questionId: string;
    value: string;
    label: string;
    description?: string;
  }>;
}

export interface SparkDaemonHumanInteractionRoute {
  workspaceBindingId: string;
  workspaceId: string;
  serverUrl: string;
}

export interface SparkDaemonHumanInteractionResponseInput {
  /** Stable across client retries so an accepted response can be replayed safely. */
  humanResponseId?: string;
  status: "answered" | "cancelled";
  answers: Record<string, unknown>;
  responseArtifactRefs: string[];
}

export type SparkDaemonHumanInteractionResponder = (
  wait: SparkDaemonHumanWaitRecord,
  input: SparkDaemonHumanInteractionResponseInput,
) => Promise<SparkDaemonHumanWaitDeliveryResult>;

export interface SparkDaemonHumanInteractionBrokerOptions {
  db: DatabaseSync;
  waits: SparkDaemonHumanWaitRegistry;
  getRuntimeId(route: SparkDaemonHumanInteractionRoute): string | undefined;
  /** Wake/flush the durable request outbox after the registration commits. */
  onOutboxReady?: () => void | Promise<void>;
  /** Optional channel projection (QQ keyboard); failure must not lose the Cockpit request. */
  onRequestOpened?: (input: SparkDaemonHumanInteractionOpened) => void | Promise<void>;
}

export class SparkDaemonHumanInteractionBroker {
  private readonly options: SparkDaemonHumanInteractionBrokerOptions;

  constructor(options: SparkDaemonHumanInteractionBrokerOptions) {
    this.options = options;
  }

  /**
   * Settle a response accepted directly by this daemon and durably project the
   * committed fact so the owning Cockpit closes its pending interaction.
   */
  async respond(
    wait: SparkDaemonHumanWaitRecord,
    input: SparkDaemonHumanInteractionResponseInput,
  ): Promise<SparkDaemonHumanWaitDeliveryResult> {
    const route = resolveHumanInteractionRoute(this.options.db, {
      sessionId: wait.sessionId,
      invocationId: wait.invocationId,
      ...(wait.workspaceBindingId ? { workspaceBindingId: wait.workspaceBindingId } : {}),
      ...(wait.workspaceId ? { workspaceId: wait.workspaceId } : {}),
    });
    const runtimeId = route ? this.options.getRuntimeId(route)?.trim() : undefined;
    const wasProjectedToCockpit = wait.context.cockpitProjected === true;
    const humanResponseId = input.humanResponseId ?? createId("hres");
    const deliveryInput = {
      humanRequestId: wait.humanRequestId,
      humanResponseId,
      status: input.status,
      answers: input.answers,
      responseArtifactRefs: input.responseArtifactRefs,
    };
    if (!wasProjectedToCockpit || wait.status !== "pending") {
      return this.options.waits.deliver(deliveryInput);
    }
    if (!runtimeId || !route) {
      throw new Error(
        `Daemon could not resolve the Cockpit route for human interaction ${wait.interactionRequestId}.`,
      );
    }

    const messageId = createId("msg");
    const result = this.options.waits.deliver(deliveryInput, {
      messageId,
      kind: "human.response.recorded",
      envelope: runtimeEnvelope(
        "human.response.recorded",
        {
          source: "daemon",
          status: input.status,
          answers: input.answers,
          responseArtifactRefs: input.responseArtifactRefs,
        },
        {
          runtimeId,
          workspaceBindingId: route.workspaceBindingId,
          workspaceId: route.workspaceId,
          projectId: wait.projectId || undefined,
          humanRequestId: wait.humanRequestId,
          humanResponseId,
          invocationId: wait.invocationId || undefined,
        },
        { messageId },
      ),
    });
    await Promise.resolve(this.options.onOutboxReady?.());
    return result;
  }

  async interact(
    rawRequest: SparkInteractionRequest,
    context: SparkDaemonHumanInteractionContext,
  ): Promise<SparkInteractionResponse> {
    const request = parseSparkInteractionRequest(rawRequest);
    const durable = normalizeDurableHumanInteraction(request);
    if (!durable) {
      return createBlockedInteractionResponse(
        request,
        "Daemon-backed interaction transport currently supports askFlow and toolApproval only.",
      );
    }

    const route = resolveHumanInteractionRoute(this.options.db, context);
    const runtimeId = route ? this.options.getRuntimeId(route)?.trim() : undefined;
    const localTui = context.sessionSource === "tui";
    const cockpitProjected = Boolean(runtimeId && route);
    if (!cockpitProjected && !localTui) {
      return createBlockedInteractionResponse(
        request,
        "Daemon could not resolve a Cockpit runtime/workspace route for this ask.",
      );
    }

    const humanRequestId = createId("hreq");
    const messageId = createId("msg");
    const invocationId = runtimeInvocationId(context.invocationId);
    const callbackOptions = createCallbackOptions(durable.ask);
    const delivery = durable.ask.delivery ?? "blocking";
    const prompt =
      durable.ask.prompt?.trim() ||
      durable.ask.questions.map((question) => question.prompt).join("\n");
    const contextPayload = {
      interactionKind: request.kind,
      interactionRequestId: request.requestId,
      interactionSource: request.source,
      interactionMetadata: request.metadata,
      sessionId: context.sessionId,
      ...(context.sessionSource ? { sessionSource: context.sessionSource } : {}),
      cockpitProjected,
      delivery,
      ...(request.kind === "toolApproval"
        ? {
            toolApproval: {
              toolName: request.toolName,
              ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
              ...(request.reason ? { reason: request.reason } : {}),
            },
          }
        : {}),
      ...(context.channel ? { channel: context.channel } : {}),
      ...(callbackOptions.length > 0
        ? {
            channelCallbacks: Object.fromEntries(
              callbackOptions.map((option) => [
                option.token,
                {
                  questionId: option.questionId,
                  value: option.value,
                  label: option.label,
                },
              ]),
            ),
          }
        : {}),
    };
    const toolCallId =
      context.toolCallId ?? (request.kind === "toolApproval" ? request.toolCallId : undefined);
    const payload = {
      kind: "ask_user" as const,
      delivery,
      interactionRequestId: request.requestId,
      sessionId: context.sessionId,
      ...(toolCallId ? { toolCallId } : {}),
      title: durable.ask.title,
      prompt,
      questions: durable.ask.questions.map((question) => ({
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        required: question.required,
        ...(question.options.length > 0
          ? {
              options: question.options.map((option) => ({
                value: option.value,
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
                ...(option.preview ? { preview: option.preview } : {}),
              })),
            }
          : {}),
      })),
      context: contextPayload,
      contextArtifactRefs: [],
    };
    const envelope =
      cockpitProjected && runtimeId && route
        ? runtimeEnvelope(
            "human.request.created",
            payload,
            {
              runtimeId,
              workspaceBindingId: route.workspaceBindingId,
              workspaceId: route.workspaceId,
              projectId: context.projectId,
              humanRequestId,
              invocationId,
            },
            { messageId },
          )
        : undefined;
    const registration = this.options.waits.register(
      {
        humanRequestId,
        interactionRequestId: request.requestId,
        sessionId: context.sessionId,
        invocationId,
        workspaceBindingId: route?.workspaceBindingId ?? context.workspaceBindingId,
        workspaceId: route?.workspaceId ?? context.workspaceId,
        projectId: context.projectId,
        toolCallId,
        delivery,
        kind: "ask_user",
        title: durable.ask.title,
        prompt,
        questions: payload.questions,
        context: contextPayload,
        contextArtifactRefs: [],
      },
      envelope ? { messageId, kind: "human.request.created", envelope } : undefined,
    );

    if (envelope) await Promise.resolve(this.options.onOutboxReady?.());
    if (this.options.onRequestOpened) {
      try {
        await this.options.onRequestOpened({
          wait: registration.wait,
          request: durable.ask,
          ...(context.channel ? { channel: context.channel } : {}),
          callbackOptions,
        });
      } catch (error) {
        console.error(
          "[spark-daemon] channel ask projection failed; Cockpit request remains pending",
          error,
        );
      }
    }

    if (delivery === "async") {
      return {
        version: SPARK_PROTOCOL_VERSION,
        kind: "askFlow",
        requestId: request.requestId,
        humanRequestId,
        status: "pending",
        answers: {},
        nextAction: "resume",
        metadata: { delivery: "async" },
      };
    }

    if (!registration.response) {
      return createBlockedInteractionResponse(
        request,
        "Daemon failed to attach the blocking ask continuation.",
      );
    }
    const timeoutResponseId = durable.ask.timeoutMs ? createId("hres") : undefined;
    const cancel = (humanResponseId?: string) => {
      void this.respond(registration.wait, {
        ...(humanResponseId ? { humanResponseId } : {}),
        status: "cancelled",
        answers: {},
        responseArtifactRefs: [],
      }).catch((error: unknown) => {
        console.error("[spark-daemon] failed to cancel daemon-owned human interaction", error);
      });
    };
    const response = await awaitHumanResponse(
      registration.response,
      context.signal,
      () => cancel(),
      durable.ask.timeoutMs && timeoutResponseId
        ? { timeoutMs: durable.ask.timeoutMs, cancel: () => cancel(timeoutResponseId) }
        : undefined,
    );
    const timedOut =
      response.status === "cancelled" && response.humanResponseId === timeoutResponseId;
    const answers = sparkJsonObjectSchema.parse(response.answers);
    if (request.kind === "toolApproval") {
      const approved =
        response.status === "answered" && isToolApprovalAnswerApproved(answers, durable.ask);
      return {
        version: SPARK_PROTOCOL_VERSION,
        kind: "toolApproval",
        requestId: request.requestId,
        status: response.status === "answered" ? "answered" : "cancelled",
        approved,
        message: approved
          ? undefined
          : response.status === "answered"
            ? `tool "${request.toolName}" was rejected`
            : undefined,
        metadata: {
          delivery: "blocking",
          humanResponseId: response.humanResponseId,
          humanRequestId,
          ...(timedOut ? { timedOut: true } : {}),
        },
      };
    }
    return {
      version: SPARK_PROTOCOL_VERSION,
      kind: "askFlow",
      requestId: request.requestId,
      humanRequestId,
      status: response.status === "answered" ? "answered" : "cancelled",
      answers,
      nextAction: response.status === "answered" ? "resume" : "cancel",
      metadata: {
        delivery: "blocking",
        humanResponseId: response.humanResponseId,
        ...(timedOut ? { timedOut: true } : {}),
      },
    };
  }
}

type DurableAskFlowRequest = Extract<SparkInteractionRequest, { kind: "askFlow" }>;

function normalizeDurableHumanInteraction(
  request: SparkInteractionRequest,
): { ask: DurableAskFlowRequest } | null {
  if (request.kind === "askFlow") return { ask: request };
  if (request.kind !== "toolApproval") return null;
  const approveValue = "approve";
  const rejectValue = "reject";
  const prompt =
    request.reason?.trim() || request.prompt?.trim() || `Approve tool "${request.toolName}"?`;
  return {
    ask: parseSparkInteractionRequest({
      version: request.version,
      kind: "askFlow",
      requestId: request.requestId,
      title: request.title,
      prompt,
      delivery: "blocking",
      mode: "approval",
      source: request.source,
      questions: [
        {
          id: "approval",
          type: "single",
          required: true,
          prompt,
          options: [
            { value: approveValue, label: request.approveLabel },
            { value: rejectValue, label: request.rejectLabel },
          ],
        },
      ],
      metadata: {
        ...request.metadata,
        projectedFrom: "toolApproval",
        toolName: request.toolName,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      },
    }) as DurableAskFlowRequest,
  };
}

function isToolApprovalAnswerApproved(
  answers: Record<string, unknown>,
  ask: DurableAskFlowRequest,
): boolean {
  const questionId = ask.questions[0]?.id ?? "approval";
  const approveValue = ask.questions[0]?.options[0]?.value ?? "approve";
  const raw = answers[questionId];
  if (typeof raw === "string") return raw === approveValue || raw === "approve";
  if (Array.isArray(raw)) {
    return raw.some((value) => value === approveValue || value === "approve");
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const values = record.values;
    if (Array.isArray(values)) {
      return values.some((value) => value === approveValue || value === "approve");
    }
    const value = record.value ?? record.selected ?? record.choice;
    if (typeof value === "string") return value === approveValue || value === "approve";
  }
  return false;
}

function createCallbackOptions(
  request: DurableAskFlowRequest,
): SparkDaemonHumanInteractionOpened["callbackOptions"] {
  if (request.questions.length !== 1) return [];
  const question = request.questions[0]!;
  if (question.type !== "single" && question.type !== "preview") return [];
  return question.options.map((option) => ({
    token: randomBytes(18).toString("base64url"),
    questionId: question.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
}

function resolveHumanInteractionRoute(
  db: DatabaseSync,
  context: SparkDaemonHumanInteractionContext,
): SparkDaemonHumanInteractionRoute | null {
  // Channel ingress already carries the authoritative server workspace id.
  // Do not let a daemon-local task workspace reference shadow that route.
  if (context.channel?.workspaceId) {
    return findUniqueServerRoute(db, { serverWorkspaceId: context.channel.workspaceId });
  }

  const localReference = context.workspaceBindingId ?? context.workspaceId;
  const localRoute = localReference ? findLocalWorkspaceRoute(db, localReference) : null;
  if (localRoute?.workspaceId) {
    if (context.workspaceBindingId && context.workspaceId !== localRoute.workspaceId) return null;
    return {
      workspaceBindingId: localRoute.workspaceBindingId,
      workspaceId: localRoute.workspaceId,
      serverUrl: localRoute.serverUrl,
    };
  }

  if (localRoute) {
    return findUniqueServerRoute(db, {
      localPath: localRoute.localPath,
      ...(context.workspaceBindingId && context.workspaceId
        ? { serverWorkspaceId: context.workspaceId }
        : {}),
    });
  }

  return findUniqueServerRoute(db, {
    ...(context.workspaceId ? { serverWorkspaceId: context.workspaceId } : {}),
  });
}

function findLocalWorkspaceRoute(
  db: DatabaseSync,
  workspaceReference: string,
): {
  workspaceBindingId: string;
  workspaceId?: string;
  serverUrl: string;
  localPath: string;
} | null {
  const row = db
    .prepare(
      `SELECT w.id AS workspaceBindingId,
              dw.server_workspace_id AS workspaceId,
              COALESCE(ds.server_url, w.server_url) AS serverUrl,
              w.local_path AS localPath
       FROM workspaces w
       LEFT JOIN daemon_workspaces dw ON dw.id = w.id
       LEFT JOIN daemon_servers ds ON ds.id = dw.server_id
       WHERE w.id = ?
       LIMIT 1`,
    )
    .get(workspaceReference) as
    | {
        workspaceBindingId: string;
        workspaceId: string | null;
        serverUrl: string;
        localPath: string;
      }
    | undefined;
  if (!row) return null;
  return {
    workspaceBindingId: row.workspaceBindingId,
    serverUrl: row.serverUrl,
    localPath: row.localPath,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
  };
}

function findUniqueServerRoute(
  db: DatabaseSync,
  filters: { serverWorkspaceId?: string; localPath?: string },
): SparkDaemonHumanInteractionRoute | null {
  const rows = db
    .prepare(
      `SELECT w.id AS workspaceBindingId,
              dw.server_workspace_id AS workspaceId,
              ds.server_url AS serverUrl
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
       JOIN daemon_servers ds ON ds.id = dw.server_id
       WHERE dw.server_workspace_id IS NOT NULL
         AND (? IS NULL OR dw.server_workspace_id = ?)
         AND (? IS NULL OR w.local_path = ?)
       ORDER BY w.updated_at DESC
       LIMIT 2`,
    )
    .all(
      filters.serverWorkspaceId ?? null,
      filters.serverWorkspaceId ?? null,
      filters.localPath ?? null,
      filters.localPath ?? null,
    ) as unknown as SparkDaemonHumanInteractionRoute[];
  return rows.length === 1 ? rows[0]! : null;
}

function runtimeInvocationId(value: string): string {
  const normalized = value.trim();
  if (/^inv_[a-f0-9]{32}$/u.test(normalized)) return normalized;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `inv_${digest}`;
}

async function awaitHumanResponse<T>(
  response: Promise<T>,
  signal: AbortSignal | undefined,
  cancel: () => void,
  timeout?: { timeoutMs: number; cancel: () => void },
): Promise<T> {
  if (signal?.aborted) cancel();
  const abort = () => cancel();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = timeout ? setTimeout(timeout.cancel, timeout.timeoutMs) : undefined;
  try {
    return await response;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (timer) clearTimeout(timer);
  }
}
