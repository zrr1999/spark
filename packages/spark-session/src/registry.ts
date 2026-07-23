import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  channelAdapterFromExternalKey,
  normalizeChannelExternalKey,
  parseSparkSessionRegistryRecord,
  type SparkSessionChannelBinding,
  type SparkSessionRegistryRecord,
  type SparkSessionRelation,
  type SparkSessionScope,
  type SparkSessionStatus,
  type SparkSideThreadMode,
} from "@zendev-lab/spark-protocol/session-assignment";
import type { SparkModelRef, SparkThinkingLevel } from "@zendev-lab/spark-protocol/model-control";

const LEGACY_REGISTRY_VERSIONS = new Set([1, 2]);
const REGISTRY_VERSION = 3 as const;

export type SparkSessionUnboundPolicy = "reject" | "create";

export interface SparkSessionRegistryFile {
  version: typeof REGISTRY_VERSION;
  sessions: SparkSessionRegistryRecord[];
}

export interface SparkSessionRegistryOptions {
  /** Directory that will contain `registry.json`. */
  rootDir: string;
}

export interface CreateSparkSessionInput {
  sessionId?: string;
  /** Canonical durable owner. */
  scope?: SparkSessionScope;
  /** @deprecated Prefer scope.kind=workspace. */
  workspaceId?: string;
  title?: string;
  role?: string;
  cwd?: string;
  sessionPath?: string;
  status?: SparkSessionStatus;
  now?: Date;
}
export interface EnsureSparkSideThreadInput {
  parentSessionId: string;
  mode: SparkSideThreadMode;
  sessionId?: string;
  sessionPath?: string;
  now?: Date;
}
export interface ResetSparkSideThreadInput {
  sessionId: string;
  expectedGeneration: number;
  sessionPath: string;
  mode?: SparkSideThreadMode;
  now?: Date;
}
export interface ConfigureSparkSideThreadInput {
  sessionId: string;
  expectedGeneration: number;
  model?: SparkModelRef | null;
  thinkingLevel?: SparkThinkingLevel | null;
  now?: Date;
}

export interface BindSparkSessionInput {
  sessionId: string;
  externalKey: string;
  /** Configured adapter instance that owns this binding. */
  adapterId?: string;
  /** Rename-stable provider account that owns this binding. */
  adapterAccountIdentity?: string;
  /** Internal compatibility gate for claiming a fully unscoped legacy binding. */
  allowLegacyAccountClaim?: boolean;
  now?: Date;
}

export interface RecordSparkSessionRunInput {
  sessionId: string;
  sessionPath: string;
  now?: Date;
}

export interface RelocateSparkSessionTranscriptInput extends RecordSparkSessionRunInput {
  expectedSessionPath?: string;
}

export interface ResolveBindingInput {
  externalKey: string;
  /** Configured adapter instance that observed this inbound message. */
  adapterId?: string;
  /** Rename-stable provider account that observed this inbound message. */
  adapterAccountIdentity?: string;
  /** Allow exactly one pre-account binding to be claimed by this account. */
  allowLegacyAccountClaim?: boolean;
  onUnbound?: SparkSessionUnboundPolicy;
  create?: Omit<CreateSparkSessionInput, "sessionId">;
  now?: Date;
}

export class SparkSessionRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SparkSessionRegistryError";
    this.code = code;
  }
}

export class SparkSessionRegistry {
  readonly rootDir: string;
  readonly filePath: string;

  constructor(options: SparkSessionRegistryOptions) {
    this.rootDir = options.rootDir;
    this.filePath = join(options.rootDir, "registry.json");
  }

  async create(input: CreateSparkSessionInput): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const now = (input.now ?? new Date()).toISOString();
    const sessionId = input.sessionId?.trim() || createSessionId();
    if (file.sessions.some((session) => session.sessionId === sessionId)) {
      throw new SparkSessionRegistryError("session_exists", `session already exists: ${sessionId}`);
    }
    const scope = createScope(input);
    const role = normalizeSessionRole(input.role);
    const legacyTitle = normalizeSessionRole(input.title);
    const ownership =
      scope.kind === "workspace" ? { scope, workspaceId: scope.workspaceId } : { scope };
    const record: SparkSessionRegistryRecord = {
      sessionId,
      ...ownership,
      status: input.status ?? "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
      // Local role-managed sessions mirror role into title for compatibility.
      // Platform-owned channel creation may still provide a technical title
      // without enrolling that session in generic role management.
      ...(role ? { title: role, role } : legacyTitle ? { title: legacyTitle } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
    };
    file.sessions.push(record);
    await this.saveFile(file);
    return record;
  }

  async ensureSideThread(input: EnsureSparkSideThreadInput): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const parent = requireParent(file.sessions, input.parentSessionId);
    const existing = file.sessions.find(
      (s) => s.relation?.kind === "side_thread" && s.relation.parentSessionId === parent.sessionId,
    );
    if (existing) return requireChild(existing);
    const sessionId = input.sessionId?.trim() || createSessionId();
    if (file.sessions.some((s) => s.sessionId === sessionId))
      throw new SparkSessionRegistryError("session_exists", `session already exists: ${sessionId}`);
    const path = input.sessionPath?.trim();
    if (input.sessionPath !== undefined && !path)
      throw new SparkSessionRegistryError(
        "invalid_session_path",
        "side-thread session path must not be blank",
      );
    const now = (input.now ?? new Date()).toISOString();
    const ownership =
      parent.scope.kind === "workspace"
        ? { scope: parent.scope, workspaceId: parent.scope.workspaceId }
        : { scope: parent.scope };
    const record: SparkSessionRegistryRecord = {
      sessionId,
      ...ownership,
      status: "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
      ...(parent.cwd ? { cwd: parent.cwd } : {}),
      ...(path ? { sessionPath: path } : {}),
      relation: {
        kind: "side_thread",
        parentSessionId: parent.sessionId,
        generation: 1,
        mode: input.mode,
      },
    };
    file.sessions.push(record);
    await this.saveFile(file);
    return record;
  }

  async resetSideThread(input: ResetSparkSideThreadInput): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((s) => s.sessionId === input.sessionId);
    if (index < 0)
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    const current = requireChild(file.sessions[index]!);
    assertGeneration(current, input.expectedGeneration);
    requireParent(file.sessions, current.relation.parentSessionId);
    const path = input.sessionPath.trim();
    if (!path)
      throw new SparkSessionRegistryError(
        "invalid_session_path",
        "side-thread session path must not be blank",
      );
    const updated: SparkSessionRegistryRecord = {
      ...current,
      status: "ready",
      sessionPath: path,
      relation: {
        ...current.relation,
        generation: current.relation.generation + 1,
        ...(input.mode ? { mode: input.mode } : {}),
      },
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async configureSideThread(
    input: ConfigureSparkSideThreadInput,
  ): Promise<SparkSessionRegistryRecord> {
    if (input.model === undefined && input.thinkingLevel === undefined)
      throw new SparkSessionRegistryError(
        "side_thread_config_empty",
        "side-thread configuration requires an override",
      );
    const file = await this.loadFile();
    const index = file.sessions.findIndex((s) => s.sessionId === input.sessionId);
    if (index < 0)
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    const current = requireChild(file.sessions[index]!);
    assertGeneration(current, input.expectedGeneration);
    requireParent(file.sessions, current.relation.parentSessionId);
    const updated: SparkSessionRegistryRecord = {
      ...current,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    if (input.model !== undefined) {
      if (input.model === null) delete updated.model;
      else updated.model = { ...input.model };
    }
    if (input.thinkingLevel !== undefined) {
      if (input.thinkingLevel === null) delete updated.thinkingLevel;
      else updated.thinkingLevel = input.thinkingLevel;
    }
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async list(
    options: {
      includeArchived?: boolean;
      includeSideThreads?: boolean;
      scope?: SparkSessionScope;
      workspaceId?: string;
    } = {},
  ): Promise<SparkSessionRegistryRecord[]> {
    const file = await this.loadFile();
    return file.sessions
      .filter((session) => {
        if (!options.includeArchived && session.status === "archived") return false;
        if (!options.includeSideThreads && session.relation?.kind === "side_thread") return false;
        const scope =
          options.scope ??
          (options.workspaceId
            ? ({ kind: "workspace", workspaceId: options.workspaceId } as const)
            : undefined);
        if (scope && !sameSessionScope(session.scope, scope)) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(sessionId: string): Promise<SparkSessionRegistryRecord | undefined> {
    const file = await this.loadFile();
    return file.sessions.find((session) => session.sessionId === sessionId);
  }

  async require(sessionId: string): Promise<SparkSessionRegistryRecord> {
    const record = await this.get(sessionId);
    if (!record) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    return record;
  }

  async bind(input: BindSparkSessionInput): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const externalKey = normalizeChannelExternalKey(input.externalKey);
    const adapter = channelAdapterFromExternalKey(externalKey);
    const adapterId = input.adapterId?.trim() || undefined;
    const adapterAccountIdentity = input.adapterAccountIdentity?.trim() || undefined;
    const now = (input.now ?? new Date()).toISOString();
    const existingMatch = selectChannelBinding(file.sessions, {
      externalKey,
      adapterId,
      adapterAccountIdentity,
      // bind() is an explicit ownership operation, so it may upgrade the one
      // legacy unscoped binding selected by the caller's session id.
      allowLegacyAccountClaim: input.allowLegacyAccountClaim !== false,
    });
    const existingOwner = existingMatch?.session;
    if (existingOwner && existingOwner.sessionId !== input.sessionId) {
      throw new SparkSessionRegistryError(
        "binding_conflict",
        `channel binding ${bindingIdentityLabel({ externalKey, adapterAccountIdentity })} already bound to ${existingOwner.sessionId}`,
      );
    }
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    if (current.relation?.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `side thread ${input.sessionId} cannot own a channel binding`,
      );
    }
    if (current.status === "archived") {
      throw new SparkSessionRegistryError(
        "session_archived",
        `cannot bind archived session: ${input.sessionId}`,
      );
    }
    const existingBindingIndex = existingMatch
      ? current.bindings.indexOf(existingMatch.binding)
      : -1;
    if (existingBindingIndex >= 0) {
      const existingBinding = current.bindings[existingBindingIndex]!;
      if (
        !adapterAccountIdentity &&
        adapterId &&
        existingBinding.adapterId &&
        existingBinding.adapterId !== adapterId
      ) {
        throw new SparkSessionRegistryError(
          "binding_conflict",
          `externalKey ${externalKey} is bound through adapter ${existingBinding.adapterId}, not ${adapterId}`,
        );
      }
      const nextBinding: SparkSessionChannelBinding = {
        ...existingBinding,
        ...(adapterId ? { adapterId } : {}),
        ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
      };
      if (
        nextBinding.adapterId === existingBinding.adapterId &&
        nextBinding.adapterAccountIdentity === existingBinding.adapterAccountIdentity
      ) {
        return current;
      }
      const bindings = [...current.bindings];
      bindings[existingBindingIndex] = nextBinding;
      const updated: SparkSessionRegistryRecord = {
        ...current,
        bindings,
        updatedAt: now,
      };
      file.sessions[index] = updated;
      await this.saveFile(file);
      return updated;
    }
    const binding: SparkSessionChannelBinding = {
      kind: "channel",
      adapter,
      ...(adapterId ? { adapterId } : {}),
      ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
      externalKey,
      boundAt: now,
    };
    const updated: SparkSessionRegistryRecord = {
      ...current,
      bindings: [...current.bindings, binding],
      updatedAt: now,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async unbind(
    sessionId: string,
    externalKey: string,
    adapterAccountIdentity?: string,
  ): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const normalized = normalizeChannelExternalKey(externalKey);
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.relation?.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `side thread ${sessionId} cannot own a channel binding`,
      );
    }
    const normalizedAccountIdentity = adapterAccountIdentity?.trim() || undefined;
    const externalMatches = current.bindings.filter(
      (binding) => binding.externalKey === normalized,
    );
    const matchingBindings = normalizedAccountIdentity
      ? externalMatches.filter(
          (binding) => binding.adapterAccountIdentity === normalizedAccountIdentity,
        )
      : externalMatches;
    if (matchingBindings.length === 0) {
      throw new SparkSessionRegistryError(
        "binding_not_found",
        `session ${sessionId} has no binding ${bindingIdentityLabel({
          externalKey: normalized,
          adapterAccountIdentity: normalizedAccountIdentity,
        })}`,
      );
    }
    if (matchingBindings.length > 1) {
      throw new SparkSessionRegistryError(
        "binding_ambiguous",
        `session ${sessionId} has multiple provider accounts bound to ${normalized}`,
      );
    }
    const bindingToRemove = matchingBindings[0]!;
    const nextBindings = current.bindings.filter((binding) => binding !== bindingToRemove);
    const updated: SparkSessionRegistryRecord = {
      ...current,
      bindings: nextBindings,
      updatedAt: new Date().toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async archive(sessionId: string, now = new Date()): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.relation?.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `side thread ${sessionId} is archived only with its parent`,
      );
    }
    if (current.bindings.some((binding) => binding.kind === "channel")) {
      throw new SparkSessionRegistryError(
        "session_channel_bound",
        `cannot archive channel-bound session: ${sessionId}`,
      );
    }
    const updated: SparkSessionRegistryRecord = {
      ...current,
      status: "archived",
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = updated;
    if (!current.relation) {
      for (let childIndex = 0; childIndex < file.sessions.length; childIndex += 1) {
        const child = file.sessions[childIndex]!;
        if (
          child.relation?.kind === "side_thread" &&
          child.relation.parentSessionId === current.sessionId &&
          child.status !== "archived"
        )
          file.sessions[childIndex] = {
            ...child,
            status: "archived",
            updatedAt: now.toISOString(),
          };
      }
    }
    await this.saveFile(file);
    return updated;
  }

  /**
   * Assign the generated division of labour for an unassigned user session.
   *
   * This compare-and-set transition deliberately becomes a no-op when another
   * writer has already titled, channel-bound, or archived the session. The
   * daemon serializes this complete read-modify-write operation, so a slow
   * advisory role model can never overwrite newer user/channel state.
   */
  async setRoleIfMissing(
    sessionId: string,
    role: string,
    now = new Date(),
  ): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (
      current.role?.trim() ||
      current.title?.trim() ||
      current.relation?.kind === "side_thread" ||
      current.bindings.some((binding) => binding.kind === "channel") ||
      current.status === "archived"
    ) {
      return current;
    }
    const normalizedRole = normalizeSessionRole(role);
    if (!normalizedRole) {
      throw new SparkSessionRegistryError(
        "invalid_session_role",
        `session role must not be blank: ${sessionId}`,
      );
    }
    const observedAt = now.toISOString();
    const updated: SparkSessionRegistryRecord = {
      ...current,
      title: normalizedRole,
      role: normalizedRole,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /** @deprecated Compatibility alias; session identity is role-owned. */
  async setTitleIfMissing(
    sessionId: string,
    title: string,
    now = new Date(),
  ): Promise<SparkSessionRegistryRecord> {
    return await this.setRoleIfMissing(sessionId, title, now);
  }

  async setModel(
    sessionId: string,
    model: SparkModelRef,
    now = new Date(),
  ): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.relation?.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `configure side-thread model through the side-thread control surface: ${sessionId}`,
      );
    }
    if (current.status === "archived") {
      throw new SparkSessionRegistryError(
        "session_archived",
        `cannot change model for archived session: ${sessionId}`,
      );
    }
    const updated: SparkSessionRegistryRecord = {
      ...current,
      model: { ...model },
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async setThinkingLevel(
    sessionId: string,
    thinkingLevel: NonNullable<SparkSessionRegistryRecord["thinkingLevel"]>,
    now = new Date(),
  ): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.relation?.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `configure side-thread thinking through the side-thread control surface: ${sessionId}`,
      );
    }
    if (current.status === "archived") {
      throw new SparkSessionRegistryError(
        "session_archived",
        `cannot change thinking level for archived session: ${sessionId}`,
      );
    }
    const updated: SparkSessionRegistryRecord = {
      ...current,
      thinkingLevel,
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /**
   * Record the durable native transcript produced by a completed turn.
   * Re-applying the same path is safe; the supplied observation time is kept
   * monotonic so a delayed retry cannot move the session backwards.
   */
  async recordRun(input: RecordSparkSessionRunInput): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    const sessionPath = normalizedSessionPath(input.sessionPath, input.sessionId);
    if (
      current.sessionPath &&
      normalizedSessionPath(current.sessionPath, input.sessionId) !== sessionPath
    ) {
      throw new SparkSessionRegistryError(
        "session_transcript_conflict",
        `session ${input.sessionId} is already bound to ${current.sessionPath}`,
      );
    }
    const observedAt = (input.now ?? new Date()).toISOString();
    const updated: SparkSessionRegistryRecord = {
      ...current,
      sessionPath,
      status: current.status === "archived" ? "archived" : "ready",
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /** Bind a recovered or preallocated transcript without changing run status. */
  async bindTranscriptPath(input: RecordSparkSessionRunInput): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    const sessionPath = normalizedSessionPath(input.sessionPath, input.sessionId);
    if (current.sessionPath) {
      if (normalizedSessionPath(current.sessionPath, input.sessionId) !== sessionPath) {
        throw new SparkSessionRegistryError(
          "session_transcript_conflict",
          `session ${input.sessionId} is already bound to ${current.sessionPath}`,
        );
      }
      return current;
    }
    const observedAt = (input.now ?? new Date()).toISOString();
    const updated: SparkSessionRegistryRecord = {
      ...current,
      sessionPath,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /**
   * Explicit transcript relocation used by daemon-owned repair tooling.
   * Ordinary run completion must never use this path-changing operation.
   */
  async relocateTranscriptPath(
    input: RelocateSparkSessionTranscriptInput,
  ): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    if (current.relation?.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `relocate side-thread transcript through its generation control: ${input.sessionId}`,
      );
    }
    const expectedPath = input.expectedSessionPath
      ? normalizedSessionPath(input.expectedSessionPath, input.sessionId)
      : undefined;
    const currentPath = current.sessionPath
      ? normalizedSessionPath(current.sessionPath, input.sessionId)
      : undefined;
    if (currentPath !== expectedPath) {
      throw new SparkSessionRegistryError(
        "session_transcript_cas_failed",
        `session ${input.sessionId} transcript changed before relocation`,
      );
    }
    const sessionPath = normalizedSessionPath(input.sessionPath, input.sessionId);
    const observedAt = (input.now ?? new Date()).toISOString();
    const updated: SparkSessionRegistryRecord = {
      ...current,
      sessionPath,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async recordTurnQueued(sessionId: string, now = new Date()): Promise<SparkSessionRegistryRecord> {
    return await this.recordTurnStatus(sessionId, "running", now);
  }

  async recordTurnSettled(
    sessionId: string,
    now = new Date(),
  ): Promise<SparkSessionRegistryRecord> {
    return await this.recordTurnStatus(sessionId, "ready", now);
  }

  async resolveBinding(input: ResolveBindingInput): Promise<SparkSessionRegistryRecord> {
    const externalKey = normalizeChannelExternalKey(input.externalKey);
    const adapterId = input.adapterId?.trim() || undefined;
    const adapterAccountIdentity = input.adapterAccountIdentity?.trim() || undefined;
    const file = await this.loadFile();
    const existingMatch = selectChannelBinding(file.sessions, {
      externalKey,
      adapterId,
      adapterAccountIdentity,
      allowLegacyAccountClaim: input.allowLegacyAccountClaim === true,
    });
    const existing = existingMatch?.session;
    if (existing) {
      if (existing.status === "archived") {
        throw new SparkSessionRegistryError(
          "session_archived",
          `bound session is archived: ${existing.sessionId}`,
        );
      }
      if (!adapterId && !adapterAccountIdentity) return existing;
      return await this.bind({
        sessionId: existing.sessionId,
        externalKey,
        ...(adapterId ? { adapterId } : {}),
        ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
        now: input.now,
      });
    }
    const policy = input.onUnbound ?? "reject";
    if (policy === "reject") {
      throw new SparkSessionRegistryError("binding_unbound", `no session bound to ${externalKey}`);
    }
    if (!input.create) {
      throw new SparkSessionRegistryError(
        "create_required",
        `onUnbound=create requires create input for ${externalKey}`,
      );
    }
    const created = await this.create({ ...input.create, now: input.now });
    return await this.bind({
      sessionId: created.sessionId,
      externalKey,
      ...(adapterId ? { adapterId } : {}),
      ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
      // resolveBinding already decided that this account has no owner. Do not
      // let the lower-level bind step silently claim a different legacy row.
      allowLegacyAccountClaim: false,
      now: input.now,
    });
  }

  private async loadFile(): Promise<SparkSessionRegistryFile> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return parseRegistryFile(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: REGISTRY_VERSION, sessions: [] };
      }
      throw error;
    }
  }

  private async recordTurnStatus(
    sessionId: string,
    status: "ready" | "running",
    now: Date,
  ): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.status === "archived") {
      throw new SparkSessionRegistryError(
        "session_archived",
        `cannot queue a turn for archived session: ${sessionId}`,
      );
    }
    const observedAt = now.toISOString();
    const updated: SparkSessionRegistryRecord = {
      ...current,
      status,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  private async saveFile(file: SparkSessionRegistryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

export function defaultSparkSessionRegistryRoot(sparkHome: string): string {
  // Keep the established directory so existing installations are migrated in
  // place; registry.json carries its own independently versioned file format.
  return join(sparkHome, "session-registry", "v1");
}

function parseRegistryFile(value: unknown): SparkSessionRegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SparkSessionRegistryError("invalid_registry", "registry root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== REGISTRY_VERSION &&
    !LEGACY_REGISTRY_VERSIONS.has(Number(record.version))
  ) {
    throw new SparkSessionRegistryError(
      "invalid_registry",
      `unsupported registry version: ${String(record.version)}`,
    );
  }
  if (!Array.isArray(record.sessions)) {
    throw new SparkSessionRegistryError("invalid_registry", "sessions must be an array");
  }
  return {
    version: REGISTRY_VERSION,
    sessions: record.sessions.map((session) => parseSparkSessionRegistryRecord(session)),
  };
}

function createSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createScope(input: CreateSparkSessionInput): SparkSessionScope {
  if (input.scope) {
    if (
      input.workspaceId &&
      (input.scope.kind !== "workspace" || input.scope.workspaceId !== input.workspaceId)
    ) {
      throw new SparkSessionRegistryError(
        "invalid_scope",
        "workspaceId must match workspace session scope",
      );
    }
    return input.scope;
  }
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) {
    throw new SparkSessionRegistryError("invalid_scope", "session scope is required");
  }
  return { kind: "workspace", workspaceId };
}

function requireParent(
  sessions: SparkSessionRegistryRecord[],
  sessionId: string,
): SparkSessionRegistryRecord {
  const parent = sessions.find((s) => s.sessionId === sessionId);
  if (!parent)
    throw new SparkSessionRegistryError(
      "side_thread_parent_not_found",
      `unknown side-thread parent: ${sessionId}`,
    );
  if (parent.relation)
    throw new SparkSessionRegistryError(
      "side_thread_nesting_forbidden",
      "a side thread cannot be parented by a side thread",
    );
  if (parent.status === "archived")
    throw new SparkSessionRegistryError(
      "side_thread_parent_archived",
      `archived parent: ${sessionId}`,
    );
  return parent;
}
function requireChild(session: SparkSessionRegistryRecord): SparkSessionRegistryRecord & {
  relation: Extract<SparkSessionRelation, { kind: "side_thread" }>;
} {
  if (session.relation?.kind !== "side_thread")
    throw new SparkSessionRegistryError(
      "side_thread_not_found",
      `not a side thread: ${session.sessionId}`,
    );
  if (session.status === "archived")
    throw new SparkSessionRegistryError(
      "side_thread_archived",
      `archived side thread: ${session.sessionId}`,
    );
  return session as SparkSessionRegistryRecord & {
    relation: Extract<SparkSessionRelation, { kind: "side_thread" }>;
  };
}
function assertGeneration(
  session: SparkSessionRegistryRecord & {
    relation: Extract<SparkSessionRelation, { kind: "side_thread" }>;
  },
  expected: number,
): void {
  if (session.relation.generation !== expected)
    throw new SparkSessionRegistryError(
      "side_thread_generation_conflict",
      `expected generation ${expected}, found ${session.relation.generation}`,
    );
}

function sameSessionScope(left: SparkSessionScope, right: SparkSessionScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "workspace"
    ? left.workspaceId === (right as Extract<SparkSessionScope, { kind: "workspace" }>).workspaceId
    : left.daemonId === (right as Extract<SparkSessionScope, { kind: "daemon" }>).daemonId;
}

function normalizeSessionRole(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function normalizedSessionPath(value: string, sessionId: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new SparkSessionRegistryError(
      "invalid_session_path",
      `session path must not be blank: ${sessionId}`,
    );
  }
  return resolve(normalized);
}

interface ChannelBindingSelector {
  externalKey: string;
  adapterId?: string;
  adapterAccountIdentity?: string;
  allowLegacyAccountClaim?: boolean;
}

interface SelectedChannelBinding {
  session: SparkSessionRegistryRecord;
  binding: SparkSessionChannelBinding;
}

/**
 * Select one channel binding without ever guessing between provider accounts.
 *
 * Modern callers use the rename-stable account identity. A legacy binding that
 * already recorded the same configured adapter can be upgraded safely. A fully
 * unscoped legacy binding is claimable only when the caller has independently
 * established that this is the sole configured account of that platform type.
 */
function selectChannelBinding(
  sessions: SparkSessionRegistryRecord[],
  selector: ChannelBindingSelector,
): SelectedChannelBinding | undefined {
  const matches = sessions.flatMap((session) =>
    session.bindings
      .filter((binding) => binding.externalKey === selector.externalKey)
      .map((binding) => ({ session, binding })),
  );
  if (selector.adapterAccountIdentity) {
    const exact = matches.filter(
      ({ binding }) => binding.adapterAccountIdentity === selector.adapterAccountIdentity,
    );
    if (exact.length > 1) throwAmbiguousBinding(selector);
    if (exact[0]) return exact[0];

    const adapterScopedLegacy = selector.adapterId
      ? matches.filter(
          ({ binding }) =>
            !binding.adapterAccountIdentity && binding.adapterId === selector.adapterId,
        )
      : [];
    if (adapterScopedLegacy.length > 1) throwAmbiguousBinding(selector);
    if (adapterScopedLegacy[0]) return adapterScopedLegacy[0];

    if (selector.allowLegacyAccountClaim) {
      const unscopedLegacy = matches.filter(
        ({ binding }) => !binding.adapterAccountIdentity && !binding.adapterId,
      );
      if (unscopedLegacy.length > 1) throwAmbiguousBinding(selector);
      if (unscopedLegacy[0]) return unscopedLegacy[0];
    }
    return undefined;
  }
  if (selector.adapterId) {
    const exact = matches.filter(({ binding }) => binding.adapterId === selector.adapterId);
    if (exact.length > 1) throwAmbiguousBinding(selector);
    if (exact[0]) return exact[0];
  }
  if (matches.length > 1) throwAmbiguousBinding(selector);
  return matches[0];
}

function throwAmbiguousBinding(selector: ChannelBindingSelector): never {
  throw new SparkSessionRegistryError(
    "binding_ambiguous",
    `multiple provider accounts match ${bindingIdentityLabel(selector)}`,
  );
}

function bindingIdentityLabel(
  selector: Pick<ChannelBindingSelector, "externalKey" | "adapterAccountIdentity">,
): string {
  return selector.adapterAccountIdentity
    ? `${selector.adapterAccountIdentity}:${selector.externalKey}`
    : selector.externalKey;
}
