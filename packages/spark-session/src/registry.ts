import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  channelAdapterFromExternalKey,
  normalizeChannelExternalKey,
  parseSparkSessionRegistryRecord,
  type SparkSessionChannelBinding,
  type SparkSessionRegistryRecord,
  type SparkSessionScope,
  type SparkSessionStatus,
} from "@zendev-lab/spark-protocol/session-assignment";
import type { SparkModelRef } from "@zendev-lab/spark-protocol/model-control";

const LEGACY_REGISTRY_VERSION = 1 as const;
const REGISTRY_VERSION = 2 as const;

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

export interface BindSparkSessionInput {
  sessionId: string;
  externalKey: string;
  now?: Date;
}

export interface RecordSparkSessionRunInput {
  sessionId: string;
  sessionPath: string;
  now?: Date;
}

export interface ResolveBindingInput {
  externalKey: string;
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
    const ownership =
      scope.kind === "workspace" ? { scope, workspaceId: scope.workspaceId } : { scope };
    const record: SparkSessionRegistryRecord = {
      sessionId,
      ...ownership,
      status: input.status ?? "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
      ...(input.title ? { title: input.title } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
    };
    file.sessions.push(record);
    await this.saveFile(file);
    return record;
  }

  async list(
    options: { includeArchived?: boolean; scope?: SparkSessionScope; workspaceId?: string } = {},
  ): Promise<SparkSessionRegistryRecord[]> {
    const file = await this.loadFile();
    return file.sessions
      .filter((session) => {
        if (!options.includeArchived && session.status === "archived") return false;
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
    const now = (input.now ?? new Date()).toISOString();
    const existingOwner = file.sessions.find((session) =>
      session.bindings.some((binding) => binding.externalKey === externalKey),
    );
    if (existingOwner && existingOwner.sessionId !== input.sessionId) {
      throw new SparkSessionRegistryError(
        "binding_conflict",
        `externalKey ${externalKey} already bound to ${existingOwner.sessionId}`,
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
    if (current.status === "archived") {
      throw new SparkSessionRegistryError(
        "session_archived",
        `cannot bind archived session: ${input.sessionId}`,
      );
    }
    if (current.bindings.some((binding) => binding.externalKey === externalKey)) {
      return current;
    }
    const binding: SparkSessionChannelBinding = {
      kind: "channel",
      adapter,
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

  async unbind(sessionId: string, externalKey: string): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const normalized = normalizeChannelExternalKey(externalKey);
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    const nextBindings = current.bindings.filter((binding) => binding.externalKey !== normalized);
    if (nextBindings.length === current.bindings.length) {
      throw new SparkSessionRegistryError(
        "binding_not_found",
        `session ${sessionId} has no binding ${normalized}`,
      );
    }
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
    await this.saveFile(file);
    return updated;
  }

  /**
   * Assign the generated title for an otherwise untitled local session.
   *
   * This compare-and-set transition deliberately becomes a no-op when another
   * writer has already titled, channel-bound, or archived the session. The
   * daemon serializes this complete read-modify-write operation, so a slow
   * advisory title model can never overwrite newer user/channel state.
   */
  async setTitleIfMissing(
    sessionId: string,
    title: string,
    now = new Date(),
  ): Promise<SparkSessionRegistryRecord> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (
      current.title?.trim() ||
      current.bindings.some((binding) => binding.kind === "channel") ||
      current.status === "archived"
    ) {
      return current;
    }
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new SparkSessionRegistryError(
        "invalid_session_title",
        `session title must not be blank: ${sessionId}`,
      );
    }
    const observedAt = now.toISOString();
    const updated: SparkSessionRegistryRecord = {
      ...current,
      title: normalizedTitle,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
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
    const sessionPath = input.sessionPath.trim();
    if (!sessionPath) {
      throw new SparkSessionRegistryError(
        "invalid_session_path",
        `session path must not be blank: ${input.sessionId}`,
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
    const file = await this.loadFile();
    const existing = file.sessions.find((session) =>
      session.bindings.some((binding) => binding.externalKey === externalKey),
    );
    if (existing) {
      if (existing.status === "archived") {
        throw new SparkSessionRegistryError(
          "session_archived",
          `bound session is archived: ${existing.sessionId}`,
        );
      }
      return existing;
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
  if (record.version !== LEGACY_REGISTRY_VERSION && record.version !== REGISTRY_VERSION) {
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

function sameSessionScope(left: SparkSessionScope, right: SparkSessionScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "workspace"
    ? left.workspaceId === (right as Extract<SparkSessionScope, { kind: "workspace" }>).workspaceId
    : left.daemonId === (right as Extract<SparkSessionScope, { kind: "daemon" }>).daemonId;
}
