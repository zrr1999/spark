import { parseSparkSessionView } from "@zendev-lab/spark-protocol";
import { executeSparkDaemonSessionControl } from "../../session-control.ts";
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
      return { id: request.id, ok: true, result: await projectSessionMailbox(options, snapshot) };
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
