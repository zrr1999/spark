/**
 * Local RPC implementation barrel — domain modules live beside this file.
 * Public consumers should import from `../local-rpc.ts`.
 */

export {
  LocalRpcUnavailableError,
  createSparkDaemonLocalEventBus,
  localRpcSocketPath,
  type LocalDaemonRestartResult,
  type LocalDaemonStatusResult,
  type LocalDaemonStopResult,
  type LocalHumanInteractionRespondParams,
  type LocalHumanInteractionRespondResult,
  type LocalInvocationListResult,
  type LocalInvocationRetentionPreviewResult,
  type LocalInvocationRetryResult,
  type LocalRpcServer,
  type LocalTurnCancelRequest,
  type LocalTurnCancelResult,
  type LocalTurnResult,
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
  type SparkDaemonLocalEventBus,
  type WorkspaceListResult,
} from "./types.ts";

export { handleLocalRpcLine } from "./dispatch.ts";
export { parseSparkDaemonLifecycleSnapshot } from "./results.ts";
export { startLocalRpcServer } from "./transport.ts";
export {
  requestChannelConfigure,
  requestChannelNotify,
  requestChannelReload,
  requestChannelStatus,
  requestDaemonRestart,
  requestDaemonStatus,
  requestDaemonStop,
  requestSessionSnapshot,
  requestTurnCancel,
  requestTurnStatus,
  requestTurnStream,
  requestTurnSubmit,
  requestUplinkPark,
  requestUplinkPrefer,
  requestUplinkStatus,
  requestUplinkUnpark,
  requestWorkspaceAttach,
  requestWorkspaceClientAttach,
  requestWorkspaceClientHeartbeat,
  requestWorkspaceClientRelease,
  requestWorkspaceEnsureLocal,
  requestWorkspaceExecutorEnsure,
  requestWorkspaceList,
  requestWorkspaceRegister,
  requestWorkspaceRelocate,
  requestWorkspaceStop,
} from "./client.ts";

export {
  createDaemonSessionRegistry,
  createSerializedDaemonSessionRegistry,
  type DaemonSessionRegistry,
} from "../session-registry.ts";
