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
import { SparkDaemonHumanWaitRegistry, type SparkDaemonHumanWaitRecord } from "./human-waits.ts";

export interface SparkDaemonHumanInteractionContext {
  sessionId: string;
  invocationId: string;
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

export interface SparkDaemonHumanInteractionBrokerOptions {
  db: DatabaseSync;
  waits: SparkDaemonHumanWaitRegistry;
  getRuntimeId(): string | undefined;
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

  async interact(
    rawRequest: SparkInteractionRequest,
    context: SparkDaemonHumanInteractionContext,
  ): Promise<SparkInteractionResponse> {
    const request = parseSparkInteractionRequest(rawRequest);
    if (request.kind !== "askFlow") {
      return createBlockedInteractionResponse(
        request,
        "Daemon-backed interaction transport currently supports askFlow only.",
      );
    }

    const runtimeId = this.options.getRuntimeId()?.trim();
    const route = resolveHumanInteractionRoute(this.options.db, context);
    if (!runtimeId || !route) {
      return createBlockedInteractionResponse(
        request,
        "Daemon could not resolve a Cockpit runtime/workspace route for this ask.",
      );
    }

    const humanRequestId = createId("hreq");
    const messageId = createId("msg");
    const invocationId = runtimeInvocationId(context.invocationId);
    const callbackOptions = createCallbackOptions(request);
    const delivery = request.delivery ?? "blocking";
    const prompt =
      request.prompt?.trim() || request.questions.map((question) => question.prompt).join("\n");
    const contextPayload = {
      interactionKind: request.kind,
      interactionRequestId: request.requestId,
      interactionSource: request.source,
      interactionMetadata: request.metadata,
      sessionId: context.sessionId,
      delivery,
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
    const payload = {
      kind: "ask_user" as const,
      delivery,
      interactionRequestId: request.requestId,
      sessionId: context.sessionId,
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      title: request.title,
      prompt,
      questions: request.questions.map((question) => ({
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        required: question.required,
        ...(question.options.length > 0
          ? {
              options: question.options.map((option) => ({
                id: option.value,
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
              })),
            }
          : {}),
      })),
      context: contextPayload,
      contextArtifactRefs: [],
    };
    const envelope = runtimeEnvelope(
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
    );
    const registration = this.options.waits.register(
      {
        humanRequestId,
        interactionRequestId: request.requestId,
        sessionId: context.sessionId,
        invocationId,
        workspaceBindingId: route.workspaceBindingId,
        workspaceId: route.workspaceId,
        projectId: context.projectId,
        toolCallId: context.toolCallId,
        delivery,
        kind: "ask_user",
        title: request.title,
        prompt,
        questions: payload.questions,
        context: contextPayload,
        contextArtifactRefs: [],
      },
      { messageId, kind: "human.request.created", envelope },
    );

    await Promise.resolve(this.options.onOutboxReady?.());
    if (this.options.onRequestOpened) {
      try {
        await this.options.onRequestOpened({
          wait: registration.wait,
          request,
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
    const response = await awaitHumanResponse(registration.response, context.signal, () => {
      const humanResponseId = createId("hres");
      const responseMessageId = createId("msg");
      this.options.waits.deliver(
        {
          humanRequestId,
          humanResponseId,
          status: "cancelled",
          answers: {},
        },
        {
          messageId: responseMessageId,
          kind: "human.response.recorded",
          envelope: runtimeEnvelope(
            "human.response.recorded",
            {
              source: "daemon",
              status: "cancelled",
              answers: {},
              responseArtifactRefs: [],
            },
            {
              runtimeId,
              workspaceBindingId: route.workspaceBindingId,
              workspaceId: route.workspaceId,
              projectId: context.projectId,
              humanRequestId,
              humanResponseId,
              invocationId,
            },
            { messageId: responseMessageId },
          ),
        },
      );
      void Promise.resolve(this.options.onOutboxReady?.());
    });
    return {
      version: SPARK_PROTOCOL_VERSION,
      kind: "askFlow",
      requestId: request.requestId,
      humanRequestId,
      status: response.status === "answered" ? "answered" : "cancelled",
      answers: sparkJsonObjectSchema.parse(response.answers),
      nextAction: response.status === "answered" ? "resume" : "cancel",
      metadata: {
        delivery: "blocking",
        humanResponseId: response.humanResponseId,
      },
    };
  }
}

function createCallbackOptions(
  request: Extract<SparkInteractionRequest, { kind: "askFlow" }>,
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
): { workspaceBindingId: string; workspaceId: string } | null {
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
): { workspaceBindingId: string; workspaceId?: string; localPath: string } | null {
  const row = db
    .prepare(
      `SELECT w.id AS workspaceBindingId,
              dw.server_workspace_id AS workspaceId,
              w.local_path AS localPath
       FROM workspaces w
       LEFT JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.id = ?
       LIMIT 1`,
    )
    .get(workspaceReference) as
    | { workspaceBindingId: string; workspaceId: string | null; localPath: string }
    | undefined;
  if (!row) return null;
  return {
    workspaceBindingId: row.workspaceBindingId,
    localPath: row.localPath,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
  };
}

function findUniqueServerRoute(
  db: DatabaseSync,
  filters: { serverWorkspaceId?: string; localPath?: string },
): { workspaceBindingId: string; workspaceId: string } | null {
  const rows = db
    .prepare(
      `SELECT w.id AS workspaceBindingId, dw.server_workspace_id AS workspaceId
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
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
    ) as Array<{ workspaceBindingId: string; workspaceId: string }>;
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
): Promise<T> {
  if (!signal) return await response;
  if (signal.aborted) cancel();
  const abort = () => cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await response;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
