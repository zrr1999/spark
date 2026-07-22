import type {
  SparkSessionArchiveRequest,
  SparkSessionBindRequest,
  SparkSessionCreateRequest,
  SparkSessionListRequest,
  SparkModelRef,
  SparkSessionRegistryRecord,
  SparkSessionScope,
  SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import {
  defaultSparkSessionRegistryRoot,
  SparkSessionRegistry,
  SparkSessionRegistryError,
  type ConfigureSparkSideThreadInput,
  type CreateSparkSessionInput,
  type EnsureSparkSideThreadInput,
  type ResetSparkSideThreadInput,
  type ResolveBindingInput,
} from "@zendev-lab/spark-session";

/**
 * The daemon-owned session registry surface. Every daemon subsystem that can
 * mutate session state must share one instance so registry.json has one
 * read-modify-write owner inside the process.
 */
export interface DaemonSessionRegistry {
  create(input: SparkSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  list(options?: DaemonSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord | undefined>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  unbind(
    sessionId: string,
    externalKey: string,
    adapterAccountIdentity?: string,
  ): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: SparkSessionArchiveRequest["sessionId"]): Promise<SparkSessionRegistryRecord>;
  setRoleIfMissing?(sessionId: string, role: string): Promise<SparkSessionRegistryRecord>;
  /** @deprecated Compatibility alias for older daemon collaborators. */
  setTitleIfMissing?(sessionId: string, title: string): Promise<SparkSessionRegistryRecord>;
  setModel(sessionId: string, model: SparkModelRef): Promise<SparkSessionRegistryRecord>;
  setThinkingLevel(
    sessionId: string,
    thinkingLevel: SparkThinkingLevel,
  ): Promise<SparkSessionRegistryRecord>;
  recordTurnQueued(sessionId: string, now?: Date): Promise<SparkSessionRegistryRecord>;
  recordTurnSettled(sessionId: string, now?: Date): Promise<SparkSessionRegistryRecord>;
  recordRun(input: {
    sessionId: string;
    sessionPath: string;
    now?: Date;
  }): Promise<SparkSessionRegistryRecord>;
  ensureSideThread(input: EnsureSparkSideThreadInput): Promise<SparkSessionRegistryRecord>;
  resetSideThread(input: ResetSparkSideThreadInput): Promise<SparkSessionRegistryRecord>;
  configureSideThread(input: ConfigureSparkSideThreadInput): Promise<SparkSessionRegistryRecord>;
  resolveBinding(input: ResolveBindingInput): Promise<SparkSessionRegistryRecord>;
}

/** Diagnostic child visibility is daemon-internal and absent from the wire schema. */
export type DaemonSessionListRequest = SparkSessionListRequest & {
  includeSideThreads?: boolean;
};

export interface CreateDaemonSessionRegistryOptions {
  /** Stable daemon installation identity. Never accepted from a create client. */
  daemonId?: string;
  /** Base cwd used by daemon-global sessions. */
  daemonCwd?: string;
  /** Resolve a daemon-local path for a canonical or legacy workspace id. */
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
}

/**
 * Serialize complete registry transitions, including resolveBinding's
 * create-and-bind sequence. Reads wait for earlier mutations so callers never
 * observe an acknowledged transition half-applied.
 */
export function createSerializedDaemonSessionRegistry(
  registry: DaemonSessionRegistry,
): DaemonSessionRegistry {
  let mutationTail: Promise<void> = Promise.resolve();
  const readAfterMutations = async <T>(read: () => Promise<T>): Promise<T> => {
    await mutationTail;
    return await read();
  };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    create: (input) => mutate(() => registry.create(input)),
    list: (options) => readAfterMutations(() => registry.list(options)),
    get: (sessionId) => readAfterMutations(() => registry.get(sessionId)),
    bind: (input) => mutate(() => registry.bind(input)),
    unbind: (sessionId, externalKey, adapterAccountIdentity) =>
      mutate(() => registry.unbind(sessionId, externalKey, adapterAccountIdentity)),
    archive: (sessionId) => mutate(() => registry.archive(sessionId)),
    ...(registry.setRoleIfMissing
      ? {
          setRoleIfMissing: (sessionId: string, role: string) =>
            mutate(() => registry.setRoleIfMissing!(sessionId, role)),
        }
      : {}),
    ...(registry.setTitleIfMissing
      ? {
          setTitleIfMissing: (sessionId: string, title: string) =>
            mutate(() => registry.setTitleIfMissing!(sessionId, title)),
        }
      : {}),
    setModel: (sessionId, model) => mutate(() => registry.setModel(sessionId, model)),
    setThinkingLevel: (sessionId, thinkingLevel) =>
      mutate(() => registry.setThinkingLevel(sessionId, thinkingLevel)),
    recordTurnQueued: (sessionId, now) => mutate(() => registry.recordTurnQueued(sessionId, now)),
    recordTurnSettled: (sessionId, now) => mutate(() => registry.recordTurnSettled(sessionId, now)),
    recordRun: (input) => mutate(() => registry.recordRun(input)),
    ensureSideThread: (input) => mutate(() => registry.ensureSideThread(input)),
    resetSideThread: (input) => mutate(() => registry.resetSideThread(input)),
    configureSideThread: (input) => mutate(() => registry.configureSideThread(input)),
    resolveBinding: (input) => mutate(() => registry.resolveBinding(input)),
  };
}

export function createDaemonSessionRegistry(
  sparkHome: string,
  options: CreateDaemonSessionRegistryOptions = {},
): DaemonSessionRegistry {
  const registry = new SparkSessionRegistry({
    rootDir: defaultSparkSessionRegistryRoot(sparkHome),
  });
  const ownedRegistry: DaemonSessionRegistry = {
    create: async (input) => await registry.create(resolveCreateRequest(input, options)),
    list: async (request = {}) => await registry.list(resolveListRequest(request, options)),
    get: async (sessionId) => await registry.get(sessionId),
    bind: async (input) => await registry.bind(input),
    unbind: async (sessionId, externalKey, adapterAccountIdentity) =>
      await registry.unbind(sessionId, externalKey, adapterAccountIdentity),
    archive: async (sessionId) => await registry.archive(sessionId),
    setRoleIfMissing: async (sessionId, role) => await registry.setRoleIfMissing(sessionId, role),
    setTitleIfMissing: async (sessionId, title) =>
      await registry.setTitleIfMissing(sessionId, title),
    setModel: async (sessionId, model) => await registry.setModel(sessionId, model),
    setThinkingLevel: async (sessionId, thinkingLevel) =>
      await registry.setThinkingLevel(sessionId, thinkingLevel),
    recordTurnQueued: async (sessionId, now) => await registry.recordTurnQueued(sessionId, now),
    recordTurnSettled: async (sessionId, now) => await registry.recordTurnSettled(sessionId, now),
    recordRun: async (input) => await registry.recordRun(input),
    ensureSideThread: async (input) => await registry.ensureSideThread(input),
    resetSideThread: async (input) => await registry.resetSideThread(input),
    configureSideThread: async (input) => await registry.configureSideThread(input),
    resolveBinding: async (input) =>
      await registry.resolveBinding({
        ...input,
        ...(input.create ? { create: resolveRegistryCreateInput(input.create, options) } : {}),
      }),
  };
  return createSerializedDaemonSessionRegistry(ownedRegistry);
}

function resolveCreateRequest(
  input: SparkSessionCreateRequest,
  options: CreateDaemonSessionRegistryOptions,
): CreateSparkSessionInput {
  if (!input.scope) return resolveRegistryCreateInput(input, options);
  if (input.scope.kind === "daemon") {
    const daemonId = options.daemonId?.trim();
    if (!daemonId) {
      throw new SparkSessionRegistryError(
        "daemon_identity_unavailable",
        "daemon-global session creation requires a configured installationId",
      );
    }
    const daemonCwd = options.daemonCwd?.trim();
    if (!daemonCwd) {
      throw new SparkSessionRegistryError(
        "daemon_cwd_unavailable",
        "daemon-global session creation requires a daemon execution directory",
      );
    }
    const { scope: _scope, workspaceId: _workspaceId, cwd: _cwd, ...rest } = input;
    return {
      ...rest,
      scope: { kind: "daemon", daemonId },
      cwd: daemonCwd,
    };
  }
  return resolveRegistryCreateInput(
    {
      ...input,
      scope: input.scope,
      workspaceId: input.scope.workspaceId,
    },
    options,
  );
}

function resolveRegistryCreateInput(
  input: CreateSparkSessionInput,
  options: CreateDaemonSessionRegistryOptions,
): CreateSparkSessionInput {
  const scope =
    input.scope ??
    (input.workspaceId
      ? ({ kind: "workspace", workspaceId: input.workspaceId } as const)
      : undefined);
  if (!scope) return input;
  if (scope.kind === "daemon") {
    const daemonId = options.daemonId?.trim() || scope.daemonId;
    const daemonCwd = options.daemonCwd?.trim() || input.cwd?.trim();
    if (!daemonCwd) {
      throw new SparkSessionRegistryError(
        "daemon_cwd_unavailable",
        "daemon-global session creation requires a daemon execution directory",
      );
    }
    const { workspaceId: _workspaceId, ...rest } = input;
    return {
      ...rest,
      scope: { kind: "daemon", daemonId },
      cwd: daemonCwd,
    };
  }
  const resolvedWorkspaceCwd = options.resolveWorkspaceCwd?.(scope.workspaceId)?.trim();
  if (options.resolveWorkspaceCwd && !resolvedWorkspaceCwd) {
    throw new SparkSessionRegistryError(
      "workspace_cwd_unavailable",
      `workspace ${scope.workspaceId} has no daemon-local execution directory`,
    );
  }
  const requestedCwd = input.cwd?.trim();
  if (requestedCwd === "/") {
    throw new SparkSessionRegistryError(
      "workspace_cwd_unavailable",
      `workspace ${scope.workspaceId} cannot use filesystem root as execution directory`,
    );
  }
  // Workspace sessions freeze to the daemon-local workspace path whenever known.
  // Client-supplied cwd is only a fallback when the resolver is not configured.
  const cwd = resolvedWorkspaceCwd || requestedCwd;
  return {
    ...input,
    scope,
    workspaceId: scope.workspaceId,
    ...(cwd ? { cwd } : {}),
  };
}

function resolveListRequest(
  input: DaemonSessionListRequest,
  options: CreateDaemonSessionRegistryOptions,
): {
  includeArchived?: boolean;
  includeSideThreads?: boolean;
  scope?: SparkSessionScope;
  workspaceId?: string;
} {
  if (!input.scope) return input;
  if (input.scope.kind === "workspace") {
    return {
      ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      ...(input.includeSideThreads !== undefined
        ? { includeSideThreads: input.includeSideThreads }
        : {}),
      scope: input.scope,
    };
  }
  const daemonId = options.daemonId?.trim();
  if (!daemonId) {
    throw new SparkSessionRegistryError(
      "daemon_identity_unavailable",
      "daemon-global session filtering requires a configured installationId",
    );
  }
  return {
    ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
    ...(input.includeSideThreads !== undefined
      ? { includeSideThreads: input.includeSideThreads }
      : {}),
    scope: { kind: "daemon", daemonId },
  };
}
