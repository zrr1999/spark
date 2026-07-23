import { randomUUID } from "node:crypto";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  requestSparkDaemonLocalRpcWire,
  SparkDaemonLocalRpcError,
  SparkDaemonLocalRpcRemoteError,
  SparkDaemonLocalRpcUnavailableError,
} from "@zendev-lab/spark-daemon-client/local-rpc";
import type { ChannelNotifyInput, ChannelsConfig } from "@zendev-lab/spark-channels";
import {
  parseSparkSessionView,
  sparkTurnCancelResultSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import {
  LocalRpcUnavailableError,
  localRpcSocketPath,
  type LocalDaemonRestartResult,
  type LocalDaemonStatusResult,
  type LocalDaemonStopResult,
  type LocalTurnCancelParams,
  type LocalTurnCancelResult,
  type LocalTurnStatusResult,
  type LocalTurnStreamResult,
  type LocalTurnSubmitResult,
  type LocalWorkspaceClientAttachRequest,
  type LocalWorkspaceClientHeartbeatRequest,
  type LocalWorkspaceClientResult,
  type LocalWorkspaceEnsureLocalRequest,
  type LocalWorkspaceExecutorEnsureRequest,
  type LocalWorkspaceRegisterRequest,
  type LocalWorkspaceRelocateRequest,
  type LocalWorkspaceRelocateResult,
  type LocalRpcWireRequest,
  type WorkspaceListResult,
} from "./types.ts";
import {
  channelIngressStatus,
  daemonRestart,
  daemonStatus,
  daemonStop,
  localRpcResponseError,
  localWorkspaceClientResult,
  sparkDaemonWorkspace,
  turnSubmit,
  workspaceList,
} from "./results.ts";
import {
  localTurnCancelParams,
  localTurnSubmitParams,
  localWorkspaceClientAttachParams,
  localWorkspaceClientHeartbeatParams,
  localWorkspaceEnsureLocalParams,
  localWorkspaceExecutorEnsureParams,
  localWorkspaceRegisterParams,
  relocationResult,
} from "./parse.ts";
import type { LocalTurnSubmitParams } from "./types.ts";
import type { DaemonChannelIngressStatus } from "../channels/ingress.ts";
import type { SparkDaemonWorkspace } from "../store/workspaces.js";

export async function requestWorkspaceList(paths: SparkPaths): Promise<WorkspaceListResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "workspace.list" }, workspaceList);
}

export async function requestDaemonStatus(paths: SparkPaths): Promise<LocalDaemonStatusResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.status" }, daemonStatus);
}

export async function requestDaemonStop(paths: SparkPaths): Promise<LocalDaemonStopResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.stop" }, daemonStop);
}

export async function requestDaemonRestart(paths: SparkPaths): Promise<LocalDaemonRestartResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.restart" }, daemonRestart);
}

export async function requestChannelStatus(
  paths: SparkPaths,
  workspaceId: string,
): Promise<DaemonChannelIngressStatus> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "channel.status",
      params: { workspaceId },
    },
    channelIngressStatus,
  );
}

export async function requestChannelConfigure(
  paths: SparkPaths,
  workspaceId: string,
  config: ChannelsConfig,
): Promise<DaemonChannelIngressStatus> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "channel.configure",
      params: { workspaceId, config },
    },
    channelIngressStatus,
  );
}

export async function requestChannelReload(
  paths: SparkPaths,
  workspaceId: string,
): Promise<DaemonChannelIngressStatus> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "channel.reload",
      params: { workspaceId },
    },
    channelIngressStatus,
  );
}

export async function requestChannelNotify(
  paths: SparkPaths,
  params: ChannelNotifyInput & { workspaceId: string },
): Promise<unknown> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "channel.notify", params },
    (value) => value,
  );
}

export async function requestTurnSubmit(
  paths: SparkPaths,
  params: LocalTurnSubmitParams,
): Promise<LocalTurnSubmitResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "turn.submit", params: localTurnSubmitParams(params) },
    turnSubmit,
  );
}

export async function requestTurnStatus(
  paths: SparkPaths,
  invocationId: string,
): Promise<LocalTurnStatusResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "turn.status", params: { invocationId } },
    (value) => sparkTurnStatusResultSchema.parse(value),
  );
}

export async function requestTurnStream(
  paths: SparkPaths,
  params: { invocationId: string; after?: number; limit?: number },
): Promise<LocalTurnStreamResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "turn.stream", params }, (value) =>
    sparkTurnStreamPageSchema.parse(value),
  );
}

export async function requestTurnCancel(
  paths: SparkPaths,
  params: LocalTurnCancelParams,
): Promise<LocalTurnCancelResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "turn.cancel", params: localTurnCancelParams(params) },
    (value) => sparkTurnCancelResultSchema.parse(value),
  );
}

export async function requestWorkspaceRegister(
  paths: SparkPaths,
  params: LocalWorkspaceRegisterRequest,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.register",
      params: localWorkspaceRegisterParams(params),
    },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceRelocate(
  paths: SparkPaths,
  params: LocalWorkspaceRelocateRequest,
): Promise<LocalWorkspaceRelocateResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.relocate", params },
    relocationResult,
  );
}

export async function requestUplinkPark(
  paths: SparkPaths,
  params: { serverUrl: string },
): Promise<unknown> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "uplink.park", params },
    (value) => value,
  );
}

export async function requestUplinkUnpark(
  paths: SparkPaths,
  params: { serverUrl: string },
): Promise<unknown> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "uplink.unpark", params },
    (value) => value,
  );
}

export async function requestUplinkPrefer(
  paths: SparkPaths,
  params: { workspace: string; serverUrl: string; force?: boolean },
): Promise<unknown> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "uplink.prefer", params },
    (value) => value,
  );
}

export async function requestUplinkStatus(paths: SparkPaths): Promise<unknown> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "uplink.status" },
    (value) => value,
  );
}

export async function requestWorkspaceEnsureLocal(
  paths: SparkPaths,
  params: LocalWorkspaceEnsureLocalRequest,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.ensure-local",
      params: localWorkspaceEnsureLocalParams(params),
    },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceAttach(
  paths: SparkPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.attach", params: { id } },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceStop(
  paths: SparkPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.stop", params: { id } },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceClientAttach(
  paths: SparkPaths,
  params: LocalWorkspaceClientAttachRequest,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.client.attach",
      params: localWorkspaceClientAttachParams(params),
    },
    localWorkspaceClientResult,
  );
}

export async function requestWorkspaceClientHeartbeat(
  paths: SparkPaths,
  params: LocalWorkspaceClientHeartbeatRequest,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.client.heartbeat",
      params: localWorkspaceClientHeartbeatParams(params),
    },
    localWorkspaceClientResult,
  );
}

export async function requestWorkspaceClientRelease(
  paths: SparkPaths,
  clientId: string,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.client.release", params: { clientId } },
    localWorkspaceClientResult,
  );
}

export async function requestWorkspaceExecutorEnsure(
  paths: SparkPaths,
  params: LocalWorkspaceExecutorEnsureRequest,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.executor.ensure",
      params: localWorkspaceExecutorEnsureParams(params),
    },
    localWorkspaceClientResult,
  );
}

export async function requestSessionSnapshot(
  paths: SparkPaths,
  sessionId: string,
): Promise<SparkSessionView> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "session.snapshot", params: { sessionId } },
    parseSparkSessionView,
  );
}

export async function localRpcRequest<T>(
  paths: SparkPaths,
  request: LocalRpcWireRequest,
  parseResult: (value: unknown) => T,
): Promise<T> {
  const socketPath = localRpcSocketPath(paths);
  try {
    const result = await requestSparkDaemonLocalRpcWire<unknown>(request, { socketPath });
    return parseResult(result);
  } catch (error) {
    if (error instanceof SparkDaemonLocalRpcUnavailableError) {
      throw new LocalRpcUnavailableError(error.message);
    }
    if (error instanceof SparkDaemonLocalRpcRemoteError) {
      throw localRpcResponseError(error.payload);
    }
    if (error instanceof SparkDaemonLocalRpcError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

function localRequestId(): string {
  return `local-${randomUUID()}`;
}
