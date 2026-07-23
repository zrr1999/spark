import type { DatabaseSync } from "node:sqlite";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  ensureSparkDaemonRegistrationForWorkspace,
  unbindSparkDaemonWorkspaceFromCockpit,
  verifySparkDaemonWorkspaceConnection,
} from "../registration.js";
import { handleChannelRequest } from "./handlers/channel.ts";
import { handleDaemonRequest } from "./handlers/daemon.ts";
import { handleHumanRequest } from "./handlers/human.ts";
import { handleModelRequest } from "./handlers/model.ts";
import { handleSessionRequest } from "./handlers/session.ts";
import { handleSideThreadRequest } from "./handlers/side-thread.ts";
import { handleTurnRequest } from "./handlers/turn.ts";
import { handleUplinkRequest } from "./handlers/uplink.ts";
import { handleWorkspaceRequest } from "./handlers/workspace.ts";
import { isLocalRpcSafeWhileAdmissionClosed, localRpcError } from "./helpers.ts";
import { isRecord } from "./is-record.ts";
import { parseLocalRpcRequest } from "./parse.ts";
import {
  SparkDaemonStillStartingError,
  type LocalRpcHandlerOptions,
  type LocalRpcResponse,
} from "./types.ts";

export async function handleLocalRpcLine(
  line: string,
  paths: SparkPaths,
  db: DatabaseSync,
  onStop: (() => void | Promise<void>) | undefined,
  options: LocalRpcHandlerOptions = {},
): Promise<LocalRpcResponse> {
  let requestId = "unknown";
  const ensureRegistration =
    options.ensureSparkDaemonRegistrationForWorkspace ?? ensureSparkDaemonRegistrationForWorkspace;
  const verifyWorkspaceConnection =
    options.verifySparkDaemonWorkspaceConnection ?? verifySparkDaemonWorkspaceConnection;
  const unbindWorkspaceFromCockpit =
    options.unbindSparkDaemonWorkspaceFromCockpit ?? unbindSparkDaemonWorkspaceFromCockpit;
  try {
    try {
      const raw = JSON.parse(line) as unknown;
      if (isRecord(raw) && typeof raw.id === "string" && raw.id.trim()) {
        requestId = raw.id;
      }
    } catch {
      // parseLocalRpcRequest below owns the JSON/shape error message.
    }
    const request = parseLocalRpcRequest(line);
    requestId = request.id;
    if (
      options.isReady &&
      !options.isReady() &&
      !isLocalRpcSafeWhileAdmissionClosed(request.method)
    ) {
      throw new SparkDaemonStillStartingError(
        "Spark daemon is still starting; retry after readiness.",
      );
    }

    const ctx = {
      paths,
      db,
      onStop,
      options,
      ensureRegistration,
      verifyWorkspaceConnection,
      unbindWorkspaceFromCockpit,
    };

    switch (request.method) {
      case "daemon.status":
      case "daemon.stop":
      case "daemon.restart":
        return await handleDaemonRequest(ctx, request);
      case "channel.status":
      case "channel.configure":
      case "channel.reload":
      case "channel.notify":
        return await handleChannelRequest(ctx, request);
      case "human.interaction.respond":
        return await handleHumanRequest(ctx, request);
      case "turn.submit":
      case "turn.status":
      case "turn.result":
      case "turn.stream":
      case "turn.cancel":
      case "invocation.list":
      case "invocation.retry":
      case "invocation.retention.preview":
        return await handleTurnRequest(ctx, request);
      case "uplink.park":
      case "uplink.unpark":
      case "uplink.prefer":
      case "uplink.status":
        return await handleUplinkRequest(ctx, request);
      case "workspace.list":
      case "workspace.ensure-local":
      case "workspace.relocate":
      case "workspace.transfer.pending":
      case "workspace.transfer.respond":
      case "workspace.register":
      case "workspace.attach":
      case "workspace.stop":
      case "workspace.client.attach":
      case "workspace.client.heartbeat":
      case "workspace.client.release":
      case "workspace.executor.ensure":
        return await handleWorkspaceRequest(ctx, request);
      case "session.notification.deliver":
      case "session.list":
      case "session.get":
      case "session.snapshot":
      case "session.create":
      case "session.bind":
      case "session.unbind":
      case "session.archive":
      case "session.model.set":
      case "session.thinking.set":
        return await handleSessionRequest(ctx, request);
      case "side-thread.ensure":
      case "side-thread.snapshot":
      case "side-thread.submit":
      case "side-thread.reset":
      case "side-thread.configure":
      case "side-thread.handoff":
        return await handleSideThreadRequest(ctx, request);
      case "model.catalog":
      case "model.default.set":
      case "provider.auth.api-key.set":
      case "provider.auth.logout":
      case "provider.auth.login.start":
      case "provider.auth.login.status":
      case "provider.auth.login.respond":
      case "provider.auth.login.cancel":
        return await handleModelRequest(ctx, request);
      default: {
        const _exhaustive: never = request;
        void _exhaustive;
        throw new Error("Unhandled local RPC method.");
      }
    }
  } catch (error) {
    return {
      id: requestId,
      ok: false,
      error: localRpcError(error),
    };
  }
}
