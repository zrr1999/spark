import {
  parseSparkCommand,
  runtimeServerCommandSpecification,
  runtimeServerCommandSupportsScope,
  sparkCommandKindForLocalRpcMethod,
  sparkCommandKindForRuntimeServerCommand,
  sparkProtocolJsonObjectSchema,
  type ServerCommandPayload,
  type SparkCommand,
  type SparkCommandKind,
  type serverCommandEnvelopeSchema,
} from "@zendev-lab/spark-protocol";

export type RuntimeServerCommandEnvelope = ReturnType<typeof serverCommandEnvelopeSchema.parse>;

export interface LocalRpcCommandRequestLike {
  id: string;
  method: string;
  params?: unknown;
}

export interface SparkDaemonCommandPolicyInput {
  command: SparkCommand;
  runtimeId?: string | undefined;
  expectedRuntimeId?: string | undefined;
  workspaceBindingId?: string | undefined;
  knownWorkspaceBindingIds?: Set<string> | undefined;
  workspaceAccess?:
    | {
        detached?: boolean | undefined;
        borrowed?: boolean | undefined;
      }
    | undefined;
  allowMutation?: boolean | undefined;
}

export interface SparkDaemonCommandPolicyDecision {
  accepted: boolean;
  reasonCode?: string;
  message?: string;
  retryable?: boolean;
}

const borrowedWorkspaceAllowedKinds = new Set<SparkCommandKind>([
  "workspace.snapshot.request",
  "workspace.client.attach.request",
  "workspace.client.heartbeat.request",
  "workspace.client.release.request",
  "diagnostics.request",
  "invocation.cancel.request",
]);
const secretBearingLocalRpcMethods = new Set([
  "provider.auth.api-key.set",
  "provider.auth.login.respond",
  "human.interaction.respond",
]);

export function sparkCommandFromLocalRpcRequest(request: LocalRpcCommandRequestLike): SparkCommand {
  const kind = sparkCommandKindForLocalRpcMethod(request.method);
  if (!kind) {
    throw new Error(`Unknown local RPC command method: ${request.method}`);
  }
  return parseSparkCommand({
    id: request.id,
    kind,
    route: localRpcRoute(request.method, request.params),
    // Credential-bearing inputs are validated and handled directly by the
    // daemon runtime and must never enter generic command traces.
    payload:
      request.method === "channel.configure" || secretBearingLocalRpcMethods.has(request.method)
        ? {}
        : jsonObjectPayload(request.params),
    transport: {
      kind: "local-rpc",
      method: request.method,
      requestId: request.id,
    },
  });
}

export function sparkCommandFromServerCommandPayload(
  payload: ServerCommandPayload,
  route: Partial<SparkCommand["route"]> = {},
): SparkCommand {
  const kind = sparkCommandKindForRuntimeServerCommand(payload.kind);
  if (!kind) {
    throw new Error(`Unknown runtime server command kind: ${payload.kind}`);
  }
  return parseSparkCommand({
    id: route.commandId,
    kind,
    title: payload.title,
    route,
    payload: payload.payload ?? {},
    payloadRef: payload.payloadRef,
    transport: {
      kind: "runtime-ws",
      envelopeType: "server.command",
      sourceKind: payload.kind,
    },
  });
}

export function sparkCommandFromServerCommandEnvelope(
  envelope: RuntimeServerCommandEnvelope,
): SparkCommand {
  return parseSparkCommand({
    ...sparkCommandFromServerCommandPayload(envelope.payload, {
      runtimeId: envelope.runtimeId,
      workspaceBindingId: envelope.workspaceBindingId,
      workspaceId: envelope.workspaceId,
      projectId: envelope.projectId,
      commandId: envelope.commandId,
      humanRequestId: envelope.humanRequestId,
      humanResponseId: envelope.humanResponseId,
      invocationId: envelope.invocationId,
      sessionId: envelope.sessionId,
    } as Partial<SparkCommand["route"]>),
    idempotencyKey: envelope.idempotencyKey,
    requestedAt: envelope.sentAt,
    transport: {
      kind: "runtime-ws",
      envelopeType: envelope.type,
      messageId: envelope.messageId,
      sourceKind: envelope.payload.kind,
    },
  });
}

export function decideSparkDaemonCommandPolicy(
  input: SparkDaemonCommandPolicyInput,
): SparkDaemonCommandPolicyDecision {
  if (input.expectedRuntimeId && input.runtimeId !== input.expectedRuntimeId) {
    return {
      accepted: false,
      reasonCode: "RUNTIME_ID_MISMATCH",
      message: "Command was routed to a different Spark daemon runtime.",
    };
  }

  const specification = runtimeServerCommandSpecification(input.command.kind);
  if (!specification) {
    return {
      accepted: false,
      reasonCode: "COMMAND_KIND_UNKNOWN",
      message: "Command kind is not allowed over the runtime protocol.",
    };
  }

  const effectiveScope = input.workspaceBindingId ? "workspace" : "daemon";
  if (!runtimeServerCommandSupportsScope(specification, effectiveScope)) {
    return {
      accepted: false,
      reasonCode: "COMMAND_SCOPE_INVALID",
      message: `Command ${input.command.kind} does not support ${effectiveScope} scope.`,
    };
  }

  if (effectiveScope === "workspace") {
    if (!input.knownWorkspaceBindingIds?.has(input.workspaceBindingId!)) {
      return {
        accepted: false,
        reasonCode: "UNKNOWN_WORKSPACE_BINDING",
        message: "Command referenced a workspace binding this Spark daemon does not own.",
      };
    }
  }

  if (input.workspaceAccess?.detached && !specification.allowDetached) {
    return {
      accepted: false,
      reasonCode: "WORKSPACE_DETACHED",
      message: "Workspace is paused and is not accepting new commands.",
      retryable: true,
    };
  }

  if (
    input.workspaceAccess?.borrowed &&
    !specification.allowBorrowed &&
    !borrowedWorkspaceAllowedKinds.has(input.command.kind)
  ) {
    return {
      accepted: false,
      reasonCode: "WORKSPACE_BORROWED",
      message:
        "Workspace is borrowed by an interactive client and is snapshot-only for server mutations.",
      retryable: true,
    };
  }

  if (specification.operation === "mutation" && input.allowMutation === false) {
    return {
      accepted: false,
      reasonCode: "MUTATION_NOT_ALLOWED",
      message: "This command needs mutating tools, but mutation is disabled for this Spark daemon.",
    };
  }

  return { accepted: true };
}

function jsonObjectPayload(value: unknown): Record<string, unknown> {
  const parsed = sparkProtocolJsonObjectSchema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  return {};
}

function localRpcRoute(method: string, params: unknown): Partial<SparkCommand["route"]> {
  if (!isRecord(params)) return {};
  if (method === "turn.submit" && typeof params.sessionId === "string") {
    return { sessionId: params.sessionId };
  }
  if (method === "human.interaction.respond") {
    return {
      ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
      ...(typeof params.invocationId === "string" ? { invocationId: params.invocationId } : {}),
    };
  }
  if (
    (method === "turn.status" ||
      method === "turn.result" ||
      method === "turn.stream" ||
      method === "turn.cancel" ||
      method === "invocation.retry") &&
    typeof params.invocationId === "string"
  ) {
    return { invocationId: params.invocationId };
  }
  if (method.startsWith("session.") && typeof params.sessionId === "string") {
    return { sessionId: params.sessionId };
  }
  if (
    (method === "workspace.register" || method === "workspace.ensure-local") &&
    typeof params.localPath === "string"
  ) {
    return { workspaceLocalPath: params.localPath };
  }
  if (
    (method === "workspace.client.attach" || method === "workspace.executor.ensure") &&
    typeof params.workspaceId === "string"
  ) {
    return { workspaceBindingId: params.workspaceId };
  }
  if (
    (method === "workspace.client.heartbeat" || method === "workspace.client.release") &&
    typeof params.clientId === "string"
  ) {
    return { clientId: params.clientId };
  }
  if (
    (method === "workspace.attach" || method === "workspace.stop") &&
    typeof params.id === "string"
  ) {
    return { workspaceBindingId: params.id };
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
