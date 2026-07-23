import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionView,
  sparkSessionInboxResultSchema,
  sparkSessionMailMutationResultSchema,
  sparkSessionSendResultSchema,
  sparkTurnSubmitResultSchema,
  type SparkSessionMailMessage,
  type SparkSessionSendRequest,
} from "@zendev-lab/spark-protocol";
import { executeSparkDaemonSessionControl } from "../../session-control.ts";
import { SparkDriverStore } from "../../store/drivers.ts";
import {
  deliverSessionNotificationFromLocalRpc,
  projectSessionMailbox,
  requireModelControl,
  sessionControlOptions,
} from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type SessionRequest = Extract<
  LocalRpcRequest,
  {
    method:
      | "session.notification.deliver"
      | "session.list"
      | "session.get"
      | "session.snapshot"
      | "session.create"
      | "session.bind"
      | "session.unbind"
      | "session.archive"
      | "session.send"
      | "session.inbox"
      | "session.mail.read"
      | "session.mail.ack"
      | "session.model.set"
      | "session.thinking.set";
  }
>;

export async function handleSessionRequest(
  ctx: LocalRpcDispatchContext,
  request: SessionRequest,
): Promise<LocalRpcResponse> {
  const { paths, db, options } = ctx;
  switch (request.method) {
    case "session.notification.deliver": {
      const result = await deliverSessionNotificationFromLocalRpc(options, request.params);
      return { id: request.id, ok: true, result };
    }
    case "session.list": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        { kind: "session.list.request", scope: "any", payload: { ...request.params } },
      );
      return { id: request.id, ok: true, result: executed.result.sessions };
    }
    case "session.get": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.get.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return { id: request.id, ok: true, result: executed.result.session };
    }
    case "session.snapshot": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      const snapshot = parseSparkSessionView(executed.result.snapshot);
      const withDrivers = parseSparkSessionView({
        ...snapshot,
        drivers: new SparkDriverStore(db)
          .list({ ownerSessionId: request.params.sessionId })
          .map((driver) => ({
            driverId: driver.driverId,
            kind: driver.kind,
            ownerSessionId: driver.ownerSessionId,
            status: driver.status,
            continuity: driver.continuity,
            dueAt: driver.dueAt,
            attempt: driver.attempt,
            lastInvocationId: driver.lastInvocationId,
            reason: driver.reason,
            error: driver.error,
          })),
      });
      return {
        id: request.id,
        ok: true,
        result: await projectSessionMailbox(options, withDrivers),
      };
    }
    case "session.create": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        { kind: "session.create.request", scope: "any", payload: { ...request.params } },
      );
      return { id: request.id, ok: true, result: executed.result.session };
    }
    case "session.bind":
    case "session.unbind":
    case "session.archive": {
      const kind = `${request.method}.request` as
        | "session.bind.request"
        | "session.unbind.request"
        | "session.archive.request";
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind,
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return { id: request.id, ok: true, result: executed.result.session };
    }
    case "session.send": {
      const result = await sendSessionMail(ctx, request.params);
      return { id: request.id, ok: true, result };
    }
    case "session.inbox": {
      if (!options.mailStore) {
        throw new Error("Spark daemon session mail store is unavailable.");
      }
      const messages = await options.mailStore.list(request.params.sessionId, {
        includeAcked: request.params.includeAcked,
      });
      return {
        id: request.id,
        ok: true,
        result: sparkSessionInboxResultSchema.parse({ messages }),
      };
    }
    case "session.mail.read":
    case "session.mail.ack": {
      const mutate =
        request.method === "session.mail.read" ? options.mailStore?.read : options.mailStore?.ack;
      if (!mutate || !options.mailStore) {
        throw new Error("Spark daemon session mail mutation store is unavailable.");
      }
      const message = await mutate.call(
        options.mailStore,
        request.params.sessionId,
        request.params.messageId,
      );
      return {
        id: request.id,
        ok: true,
        result: sparkSessionMailMutationResultSchema.parse({ message }),
      };
    }
    case "session.model.set": {
      const session = await requireModelControl(options).setSessionModel(
        request.params.sessionId,
        request.params.model,
      );
      return { id: request.id, ok: true, result: session };
    }
    case "session.thinking.set": {
      const session = await requireModelControl(options).setSessionThinkingLevel(
        request.params.sessionId,
        request.params.thinkingLevel,
      );
      return { id: request.id, ok: true, result: session };
    }
  }
}

async function sendSessionMail(ctx: LocalRpcDispatchContext, params: SparkSessionSendRequest) {
  const { paths, db, options } = ctx;
  const mailStore = options.mailStore;
  if (!mailStore?.send || !mailStore.recordRequestAdmission) {
    throw new Error("Spark daemon session mail admission store is unavailable.");
  }
  if (params.toSessionId === params.fromSessionId) {
    throw new Error("session send must target a different session");
  }
  const targetExecuted = await executeSparkDaemonSessionControl(
    sessionControlOptions(paths, db, options),
    {
      kind: "session.get.request",
      scope: "any",
      sessionId: params.toSessionId,
      payload: { sessionId: params.toSessionId },
    },
  );
  const target = parseSparkSessionRegistryRecord(targetExecuted.result.session);
  if (params.origin.surface === "channel") {
    if (!params.originBinding) {
      throw new Error("originating channel request is missing immutable origin binding");
    }
    if (
      target.scope.kind !== "workspace" ||
      target.scope.workspaceId !== params.originBinding.workspaceId
    ) {
      throw new Error("message-platform sessions can send within their own workspace only");
    }
  }
  if (params.kind === "request") {
    if (target.status === "archived") {
      throw new Error(`cannot request archived persistent session: ${params.toSessionId}`);
    }
    if (target.bindings.length > 0) {
      throw new Error("session request targets must be local sessions");
    }
  }

  const sent = await mailStore.send({
    toSessionId: params.toSessionId,
    fromSessionId: params.fromSessionId,
    kind: params.kind,
    intent: params.intent,
    payload: params.payload,
    idempotencyKey: params.idempotencyKey,
    body: params.body,
    source: params.source,
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.subject !== undefined ? { subject: params.subject } : {}),
    ...(params.originBinding ? { originBinding: params.originBinding } : {}),
  });
  if (params.kind === "notification") {
    return sparkSessionSendResultSchema.parse({
      message: sent.message,
      filePath: sent.path,
      created: sent.created,
      executionTriggered: false,
      target,
    });
  }

  const accepted = acceptedAdmission(sent.message);
  const submitted =
    accepted ??
    sparkTurnSubmitResultSchema.parse(
      (
        await executeSparkDaemonSessionControl(sessionControlOptions(paths, db, options), {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: params.toSessionId,
          idempotencyKey: `session.mail:${sent.message.id}`,
          payload: {
            sessionId: params.toSessionId,
            prompt: sent.message.body,
            idempotencyKey: `session.mail:${sent.message.id}`,
            ...(params.originBinding ? { originBinding: params.originBinding } : {}),
            messageMetadata: {
              origin: {
                kind: "session",
                sessionId: params.fromSessionId,
                surface: params.origin.surface,
                host: params.origin.host,
              },
              sessionMail: {
                messageId: sent.message.id,
                kind: sent.message.kind,
                intent: sent.message.intent,
                correlationId: sent.message.correlationId,
                fromSessionId: sent.message.fromSessionId,
                toSessionId: sent.message.toSessionId,
                notifyOnCompletion: params.notifyOnCompletion,
                ...(params.parentInvocationId
                  ? { parentInvocationId: params.parentInvocationId }
                  : {}),
              },
            },
          },
        })
      ).result,
    );
  const message = accepted
    ? sent.message
    : await mailStore.recordRequestAdmission(params.toSessionId, sent.message.id, submitted);
  return sparkSessionSendResultSchema.parse({
    message,
    filePath: sent.path,
    created: sent.created,
    executionTriggered: true,
    target,
    submitted,
  });
}

function acceptedAdmission(message: SparkSessionMailMessage) {
  const admission = message.requestAdmission;
  if (admission?.status !== "accepted") return undefined;
  return sparkTurnSubmitResultSchema.parse({
    invocationId: admission.invocationId,
    status: "queued",
    acceptedAt: admission.acceptedAt,
  });
}
