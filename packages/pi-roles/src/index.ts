import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export type RoleSource = "builtin" | "extension" | "project" | "user";
export type WritableRoleSource = "project" | "user";
export type RoleOriginKind = "manual" | "generated" | "builtin" | "extension";
export type RoleRef = `role:${string}`;
export type RoleRunRef = `run:${string}`;
export type RoleLaunchMode = "fresh" | "forked";

export const ROLE_RUN_DEPTH_ENV = "PI_ROLE_DEPTH";
export const DEFAULT_ROLE_RUN_DEPTH = 4;

export interface RoleOrigin {
  kind: RoleOriginKind;
  sourcePath?: string;
  note?: string;
}

export interface RoleSpec {
  ref: RoleRef;
  id: string;
  source: RoleSource;
  description: string;
  systemPrompt: string;
  allowedTools?: string[];
  origin?: RoleOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSpecProposal {
  artifactRef?: string;
  id: string;
  source?: WritableRoleSource;
  description: string;
  systemPrompt: string;
  rationale: string;
  expectedUses: string[];
  allowedTools?: string[];
  origin?: RoleOrigin;
}

export interface RoleInstruction {
  roleRef: RoleRef;
  instruction: string;
  inputs?: string[];
}

export type RoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";

export interface RoleRunRecord {
  ref: RoleRunRef;
  roleRef: RoleRef;
  /** Human-readable name for this concrete role run; roleRef remains the reusable definition. */
  runName?: string;
  instruction: string;
  status: RoleRunStatus;
  outputArtifactRef?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RoleRunRequest {
  roleRef: RoleRef;
  instruction: string;
  launch?: RoleLaunchMode;
  systemPrompt?: string;
  /** Concrete Pi model to use for this run (usually current session model, unless overridden). */
  model?: string;
  /** Optional child Pi tool allowlist. Hosts/presets own which tools are appropriate. */
  allowedTools?: string[];
  /** Launch Pi without saving or reusing a session. Useful for short verifier gates. */
  noSession?: boolean;
  sessionDir?: string;
  forkFromSession?: string;
  /** Adapter-specific guidance appended between the role prompt and instruction. */
  runGuidance?: string;
}

export interface RoleRunCommandInput extends RoleRunRequest {
  systemPrompt: string;
}

export interface RoleRunLauncherInput extends RoleRunCommandInput {
  runRef: RoleRunRef;
  piCommand: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => string;
  env?: NodeJS.ProcessEnv;
  /**
   * Non-interactive role runs pass the prompt through argv and should not keep a
   * child stdin pipe open, because Pi --print may wait for stdin EOF when stdin
   * is a pipe. Interactive/background adapters can keep the default pipe for
   * best-effort follow-up delivery.
   */
  stdinMode?: "pipe" | "ignore";
  onChildProcess?: (child: ChildProcess, startedAt: string) => void;
  onTimeout?: () => void;
}

export interface RoleRunResult {
  record: RoleRunRecord & {
    launch: RoleLaunchMode;
    model?: string;
    sessionDir?: string;
    forkFromSession?: string;
    failureKind?: string;
    errorMessage?: string;
  };
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface ActiveRoleRun {
  ref: RoleRunRef;
  roleRef: RoleRef;
  launch: RoleLaunchMode;
  model?: string;
  child: ChildProcess;
  startedAt: string;
  cancel(reason?: string): boolean;
}

export const builtinRoleIds = ["scout", "worker", "reviewer"] as const;
export type BuiltinRoleId = (typeof builtinRoleIds)[number];

export const ROLE_CAPABILITY_VOCAB = ["read", "write", "exec", "net", "interact", "spawn"] as const;
export type RoleCapability = (typeof ROLE_CAPABILITY_VOCAB)[number];

export const BUILTIN_ROLE_CAPABILITY_PROFILES = {
  scout: ["read", "net"],
  reviewer: ["read", "net", "exec"],
  worker: ["read", "net", "exec", "write"],
} as const satisfies Record<BuiltinRoleId, readonly RoleCapability[]>;

export interface DefaultRoleRegistryOptions {
  now?: string;
}

const ROLE_READ_TOOLS = ["read", "grep", "find", "ls", "context"] as const;
const ROLE_NET_TOOLS = [
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
] as const;
const ROLE_EXECUTION_TOOLS = [
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
  "cue_jobs",
] as const;
const ROLE_WRITE_TOOLS = ["edit", "write"] as const;

const ROLE_TOOLS_BY_CAPABILITY = {
  read: ROLE_READ_TOOLS,
  write: ROLE_WRITE_TOOLS,
  exec: ROLE_EXECUTION_TOOLS,
  net: ROLE_NET_TOOLS,
  interact: ["ask", "ask_user", "ask_flow"],
  spawn: ["role", "assign"],
} as const satisfies Record<RoleCapability, readonly string[]>;

const FORBIDDEN_BUILTIN_ROLE_TOOLS = new Set([
  "ask",
  "ask_user",
  "ask_flow",
  "task",
  "task_read",
  "task_write",
  "goal",
  "role",
  "assign",
  "workflow",
  "graft_patch",
]);

const ROLE_FRONTMATTER_KEYS = new Set([
  "id",
  "name",
  "description",
  "source",
  "allowedTools",
  "tools",
  "origin",
  "createdAt",
  "updatedAt",
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function roleRefId(ref: string): string {
  const index = ref.indexOf(":");
  if (index < 0) return ref;
  return ref.slice(index + 1);
}

export function roleIdFromRef(ref: string): string {
  return roleRefId(normalizeRoleRef(ref)).replace(/^(builtin-|extension-|project-|user-)/, "");
}

export function builtinRoleRef(id: BuiltinRoleId): RoleRef {
  return `role:builtin-${id}`;
}

export function normalizeRoleRef(value: string): RoleRef {
  if (value.startsWith("role:")) return value as RoleRef;
  if (value.startsWith("agent:"))
    throw new Error("legacy agent refs are not supported; use role:*");
  return `role:${value}` as RoleRef;
}

export function normalizeRoleSource(value: unknown): RoleSource | undefined {
  if (value === "builtin") return "builtin";
  if (value === "extension") return "extension";
  if (value === "project") return "project";
  if (value === "user") return "user";
  return undefined;
}

export function createBuiltinRoles(now = nowIso()): RoleSpec[] {
  const roles = [
    builtin(
      "scout",
      "Fast repo and context reconnaissance.",
      "You are a Pi scout. Gather context, identify relevant files and risks, and do not edit files. When a blocker, missing user decision, or ambiguity cannot be resolved from available context, report the blocker and the exact question needed upward in your final response instead of asking interactively. Flag clearly placeholder/generic/stale project or task names so the host can safely improve them without changing refs.",
      now,
    ),
    builtin(
      "worker",
      "Executes approved implementation tasks.",
      "You are a Pi worker. Implement only the assigned instruction. When a blocker, missing requirement, approval need, or ambiguity cannot be resolved from available context, stop and report the blocker and the exact question needed upward in your final response instead of asking interactively. When the user reports a concrete repo behavior change, fix the implementation instead of only recording a preference. Flag clearly placeholder/generic/stale project or claimed-task @name/title when the current intent makes the better name clear while preserving refs and intentional user names.",
      now,
    ),
    builtin(
      "reviewer",
      "Reviews results and artifacts against task intent.",
      "You are a Pi reviewer. Verify claims from fresh context and return actionable findings. Do not ask interactively; when intent or evidence is ambiguous, reject with concrete questions in findings/blockers instead of silently assuming an answer. Call out placeholder/generic/stale project or task names only when a safe improvement is clear from context and would preserve refs.",
      now,
    ),
  ];
  validateBuiltinRoleProfiles(roles);
  return roles;
}

export function createDefaultRoleRegistry(options: DefaultRoleRegistryOptions = {}): RoleRegistry {
  const now = options.now ?? nowIso();
  return new RoleRegistry(createBuiltinRoles(now));
}

const extensionRoles = new Map<RoleRef, RoleSpec>();

export function createExtensionRoleSpec(
  input: {
    id: string;
    description: string;
    systemPrompt: string;
    allowedTools?: string[];
    origin?: RoleOrigin;
  },
  now = nowIso(),
): RoleSpec {
  const role: RoleSpec = {
    ref: createRoleRef("extension", input.id),
    id: input.id,
    source: "extension",
    description: input.description,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools,
    origin: input.origin ?? { kind: "extension" },
    createdAt: now,
    updatedAt: now,
  };
  validateRoleSpec(role);
  return role;
}

export function registerExtensionRole(role: RoleSpec): void {
  validateRoleSpec(role);
  if (role.source !== "extension")
    throw new Error(`extension role registry only accepts extension roles, got ${role.source}`);
  extensionRoles.set(role.ref, role);
}

export function listExtensionRoles(): RoleSpec[] {
  return [...extensionRoles.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function hydrateExtensionRoles(registry: RoleRegistry): void {
  for (const role of listExtensionRoles()) registry.add(role);
}

export function builtinRoleAllowedTools(id: BuiltinRoleId): string[] {
  return uniqueStrings(
    BUILTIN_ROLE_CAPABILITY_PROFILES[id].flatMap(
      (capability) => ROLE_TOOLS_BY_CAPABILITY[capability],
    ),
  );
}

export function validateBuiltinRoleProfiles(roles: readonly RoleSpec[]): void {
  if (ROLE_CAPABILITY_VOCAB.includes("record" as RoleCapability))
    throw new Error("builtin role capability vocab must not include record");
  const vocabulary = new Set<RoleCapability>(ROLE_CAPABILITY_VOCAB);
  for (const id of builtinRoleIds) {
    const profile = BUILTIN_ROLE_CAPABILITY_PROFILES[id];
    for (const capability of profile) {
      if (!vocabulary.has(capability))
        throw new Error(`builtin role ${id} declares unknown capability ${capability}`);
    }
    const profileCapabilities: readonly RoleCapability[] = profile;
    if (profileCapabilities.includes("interact") || profileCapabilities.includes("spawn"))
      throw new Error(`builtin role ${id} must not include interact or spawn capability`);
  }
  assertCapabilitySubset("scout", "reviewer");
  assertCapabilitySubset("reviewer", "worker");

  const rolesById = new Map(roles.map((role) => [role.id, role]));
  for (const id of builtinRoleIds) {
    const role = rolesById.get(id);
    if (!role) throw new Error(`missing builtin role ${id}`);
    const expectedTools = builtinRoleAllowedTools(id);
    const actualTools = role.allowedTools ?? [];
    if (!sameStrings(actualTools, expectedTools))
      throw new Error(
        `builtin role ${id} allowedTools must match its capability profile: expected ${expectedTools.join(",")}, got ${actualTools.join(",")}`,
      );
    for (const tool of actualTools) {
      if (FORBIDDEN_BUILTIN_ROLE_TOOLS.has(tool))
        throw new Error(`builtin role ${id} must not include forbidden tool ${tool}`);
    }
  }
}

function assertCapabilitySubset(left: BuiltinRoleId, right: BuiltinRoleId): void {
  const rightCapabilities = new Set<RoleCapability>(BUILTIN_ROLE_CAPABILITY_PROFILES[right]);
  for (const capability of BUILTIN_ROLE_CAPABILITY_PROFILES[left]) {
    if (!rightCapabilities.has(capability))
      throw new Error(`builtin role capability profile ${left} must be a subset of ${right}`);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function builtin(
  id: BuiltinRoleId,
  description: string,
  systemPrompt: string,
  now: string,
): RoleSpec {
  return {
    ref: builtinRoleRef(id),
    id,
    source: "builtin",
    description,
    systemPrompt,
    allowedTools: builtinRoleAllowedTools(id),
    origin: { kind: "builtin" },
    createdAt: now,
    updatedAt: now,
  };
}

export class RoleRegistry {
  #roles = new Map<RoleRef, RoleSpec>();

  constructor(initialRoles: RoleSpec[] = createBuiltinRoles()) {
    for (const role of initialRoles) this.add(role);
  }

  add(role: RoleSpec): void {
    validateRoleSpec(role);
    this.#roles.set(role.ref, role);
  }

  get(ref: string): RoleSpec {
    const role = this.#roles.get(normalizeRoleRef(ref));
    if (!role) throw new Error(`unknown role: ${ref}`);
    return role;
  }

  has(ref: string): boolean {
    return this.#roles.has(normalizeRoleRef(ref));
  }

  list(filter: { source?: RoleSource } = {}): RoleSpec[] {
    return [...this.#roles.values()]
      .filter((role) => !filter.source || role.source === filter.source)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  select(idOrRef: string, filter: { source?: RoleSource } = {}): RoleSpec {
    const normalized = idOrRef.startsWith("role:") ? normalizeRoleRef(idOrRef) : undefined;
    if (normalized) {
      const role = this.get(normalized);
      if (filter.source && role.source !== filter.source)
        throw new Error(`role ${idOrRef} does not match source ${filter.source}`);
      return role;
    }
    const matches = this.list(filter).filter(
      (role) =>
        role.id === idOrRef ||
        roleRefId(role.ref) === idOrRef ||
        roleIdFromRef(role.ref) === idOrRef,
    );
    if (matches.length === 0) throw new Error(`no role matches: ${idOrRef}`);
    if (matches.length > 1) throw new Error(`ambiguous role: ${idOrRef}`);
    return matches[0];
  }
}

export interface RoleStore {
  save(role: RoleSpec): Promise<void>;
  loadAll(): Promise<RoleSpec[]>;
  hydrate?(registry: RoleRegistry): Promise<void>;
}

export interface MarkdownRoleStoreOptions {
  rootDir: string;
  source: WritableRoleSource;
  writable?: boolean;
  originKind?: RoleOriginKind;
}

export class MarkdownRoleStore implements RoleStore {
  readonly rootDir: string;
  readonly source: WritableRoleSource;
  readonly writable: boolean;
  readonly originKind: RoleOriginKind;

  constructor(options: MarkdownRoleStoreOptions | string) {
    const normalized =
      typeof options === "string"
        ? ({ rootDir: options, source: "project" as const } satisfies MarkdownRoleStoreOptions)
        : options;
    this.rootDir = normalized.rootDir;
    this.source = normalized.source;
    this.writable = normalized.writable ?? true;
    this.originKind = normalized.originKind ?? "manual";
  }

  async save(role: RoleSpec): Promise<void> {
    validateRoleSpec(role);
    if (!this.writable) throw new Error("role store is read-only");
    if (role.source !== this.source)
      throw new Error(`only ${this.source} roles can be saved to this MarkdownRoleStore`);
    const filePath = this.pathFor(role);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, serializeRoleSpecMarkdown(role), "utf8");
  }

  async loadAll(): Promise<RoleSpec[]> {
    const paths = await findMarkdownFiles(this.rootDir);
    const roles: RoleSpec[] = [];
    for (const filePath of paths) {
      const role = parseRoleSpecMarkdown(await readFile(filePath, "utf8"), {
        source: this.source,
        id: idFromMarkdownPath(this.rootDir, filePath),
        sourcePath: filePath,
        originKind: this.originKind,
      });
      roles.push(role);
    }
    return roles;
  }

  async hydrate(registry: RoleRegistry): Promise<void> {
    for (const role of await this.loadAll()) registry.add(role);
  }

  pathFor(role: Pick<RoleSpec, "id">): string {
    return join(this.rootDir, `${role.id}.md`);
  }
}

export function defaultProjectRoleStore(cwd: string): MarkdownRoleStore {
  return new MarkdownRoleStore({ rootDir: join(cwd, ".agents", "roles"), source: "project" });
}

export function defaultUserRoleStore(home = homedir()): MarkdownRoleStore {
  return new MarkdownRoleStore({ rootDir: join(home, ".agents", "roles"), source: "user" });
}

export type RoleModelSettingsSource = "project" | "user";
export type ResolvedRoleModelSource = "explicit" | RoleModelSettingsSource;

export interface RoleModelSettingsEntry {
  selector: string;
  model: string;
  source: RoleModelSettingsSource;
}

interface RoleModelSettingsFile {
  version: 1;
  roleModels: Record<string, string>;
}

export interface ResolvedRoleModelSetting {
  model: string;
  source: ResolvedRoleModelSource;
  selector?: string;
}

export class RoleModelSettingsStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid role model settings store: ${filePath}: ${message}`);
    this.name = "RoleModelSettingsStoreFormatError";
    this.filePath = filePath;
  }
}

export class RoleModelSettingsStore {
  readonly filePath: string;
  readonly source: RoleModelSettingsSource;

  constructor(filePath: string, source: RoleModelSettingsSource) {
    this.filePath = filePath;
    this.source = source;
  }

  async loadAll(): Promise<RoleModelSettingsEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = parseRoleModelSettingsFileJson(raw, this.filePath);
    assertRoleModelSettingsFile(parsed, this.filePath);
    return Object.entries(parsed.roleModels)
      .map(([selector, model]) => ({ selector, model, source: this.source }))
      .sort((left, right) => left.selector.localeCompare(right.selector));
  }

  async get(selector: string): Promise<RoleModelSettingsEntry | undefined> {
    const normalized = normalizeRoleModelSelector(selector, "selector");
    return (await this.loadAll()).find((entry) => entry.selector === normalized);
  }

  async save(selector: string, model: string): Promise<RoleModelSettingsEntry> {
    const normalizedSelector = normalizeRoleModelSelector(selector, "selector");
    const normalizedModel = normalizeRoleModelName(model, "model");
    const entries = await this.loadAll();
    const roleModels: Record<string, string> = {};
    for (const entry of entries) roleModels[entry.selector] = entry.model;
    roleModels[normalizedSelector] = normalizedModel;
    await writeRoleModelSettingsFile(this.filePath, roleModels);
    return { selector: normalizedSelector, model: normalizedModel, source: this.source };
  }

  async delete(selector: string): Promise<boolean> {
    const normalizedSelector = normalizeRoleModelSelector(selector, "selector");
    const entries = await this.loadAll();
    const roleModels: Record<string, string> = {};
    let deleted = false;
    for (const entry of entries) {
      if (entry.selector === normalizedSelector) {
        deleted = true;
        continue;
      }
      roleModels[entry.selector] = entry.model;
    }
    if (deleted) await writeRoleModelSettingsFile(this.filePath, roleModels);
    return deleted;
  }
}

export function defaultProjectRoleModelSettingsStore(cwd: string): RoleModelSettingsStore {
  return new RoleModelSettingsStore(join(cwd, ".spark", "role-model-settings.json"), "project");
}

export function defaultUserRoleModelSettingsStore(
  home = process.env.PI_ROLES_HOME || homedir(),
): RoleModelSettingsStore {
  return new RoleModelSettingsStore(join(home, ".agents", "role-model-settings.json"), "user");
}

export async function resolveRoleModelSetting(input: {
  explicitModel?: string;
  roleRef: string;
  roleId?: string;
  roleName?: string;
  projectStore?: RoleModelSettingsStore;
  userStore?: RoleModelSettingsStore;
}): Promise<ResolvedRoleModelSetting | undefined> {
  const explicitModel = input.explicitModel?.trim();
  if (explicitModel) return { model: explicitModel, source: "explicit" };
  const roleRef = normalizeRoleRef(input.roleRef);
  const selectors = roleModelSelectors({ roleRef, roleId: input.roleId, roleName: input.roleName });
  for (const store of [input.projectStore, input.userStore]) {
    if (!store) continue;
    const entries = await store.loadAll();
    for (const selector of selectors) {
      const entry = entries.find((candidate) => candidate.selector === selector);
      if (entry) return { model: entry.model, source: entry.source, selector: entry.selector };
    }
  }
  return undefined;
}

function roleModelSelectors(input: {
  roleRef: RoleRef;
  roleId?: string;
  roleName?: string;
}): string[] {
  const candidates = [
    input.roleRef,
    input.roleRef.slice("role:".length),
    input.roleId,
    input.roleName,
  ];
  return [
    ...new Set(
      candidates.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  ];
}

function normalizeRoleModelSelector(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`role model ${field} is required`);
  return value.trim();
}

function normalizeRoleModelName(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`role model ${field} is required`);
  return value.trim();
}

function parseRoleModelSettingsFileJson(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RoleModelSettingsStoreFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertRoleModelSettingsFile(
  value: unknown,
  filePath: string,
): asserts value is RoleModelSettingsFile {
  if (!isRecord(value)) {
    throw new RoleModelSettingsStoreFormatError(filePath, "JSON root must be an object");
  }
  if (value.version !== 1) {
    throw new RoleModelSettingsStoreFormatError(filePath, "version must be 1");
  }
  if (!isRecord(value.roleModels)) {
    throw new RoleModelSettingsStoreFormatError(filePath, "roleModels must be an object");
  }
  for (const [selector, model] of Object.entries(value.roleModels)) {
    if (!selector.trim())
      throw new RoleModelSettingsStoreFormatError(
        filePath,
        "roleModels selectors must be non-empty",
      );
    if (typeof model !== "string" || !model.trim())
      throw new RoleModelSettingsStoreFormatError(
        filePath,
        `roleModels.${selector} must be a non-empty string`,
      );
  }
}

async function writeRoleModelSettingsFile(
  filePath: string,
  roleModels: Record<string, string>,
): Promise<void> {
  const sorted = Object.fromEntries(
    Object.entries(roleModels).sort(([left], [right]) => left.localeCompare(right)),
  );
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteFile(
    filePath,
    `${JSON.stringify({ version: 1, roleModels: sorted } satisfies RoleModelSettingsFile, null, 2)}\n`,
  );
}

export async function validateRoleModel(input: {
  piCommand: string;
  model: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<void> {
  const model = input.model.trim();
  if (!model) throw new Error("role model is required");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.piCommand, ["--list-models", model], {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`model validation timed out for ${model}`));
    }, input.timeoutMs ?? 15_000);
    timer.unref?.();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const output = [stdout, stderr].filter(Boolean).join("\n");
      if (code === 0 && !isNoMatchingModelOutput(output)) resolve();
      else {
        reject(new Error(`model validation failed for ${model}: ${output || `exit ${code}`}`));
      }
    });
  });
}

function isNoMatchingModelOutput(output: string): boolean {
  return /no\s+models?\s+(?:found\s+)?matching\b/i.test(output);
}

async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await cleanupAtomicWriteTempFile(tempPath, error);
    throw error;
  }
}

async function cleanupAtomicWriteTempFile(tempPath: string, writeError: unknown): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch (cleanupError) {
    throw new Error(
      `atomic write failed and temporary file cleanup also failed: ${tempPath}; write error: ${unknownErrorMessage(writeError)}; cleanup error: ${unknownErrorMessage(cleanupError)}`,
    );
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function hydrateDefaultRoleRegistry(
  registry: RoleRegistry,
  cwd: string,
  options: {
    home?: string;
    includeUser?: boolean;
  } = {},
): Promise<void> {
  hydrateExtensionRoles(registry);
  await defaultProjectRoleStore(cwd).hydrate(registry);
  if (options.includeUser) await defaultUserRoleStore(options.home).hydrate(registry);
}

export function createRoleSpec(proposal: RoleSpecProposal, now = nowIso()): RoleSpec {
  const source = proposal.source ?? "project";
  return {
    ref: createRoleRef(source, proposal.id),
    id: proposal.id,
    source,
    description: proposal.description,
    systemPrompt: proposal.systemPrompt,
    allowedTools: proposal.allowedTools,
    origin: proposal.origin,
    createdAt: now,
    updatedAt: now,
  };
}

export function createRoleRef(source: RoleSource, id: string): RoleRef {
  if (source === "builtin") return `role:builtin-${sanitizeRoleRefPart(id)}`;
  if (source === "extension") return `role:extension-${sanitizeRoleRefPart(id)}`;
  return `role:${source}-${stableId(id)}`;
}

export function validateRoleSpec(role: RoleSpec): void {
  if (!role.ref.startsWith("role:")) throw new Error(`invalid role ref: ${role.ref}`);
  assertNonEmpty(role.id, "role id");
  assertNonEmpty(role.description, `role ${role.id} description`);
  assertNonEmpty(role.systemPrompt, `role ${role.id} system prompt`);
  if (!normalizeRoleSource(role.source))
    throw new Error(`invalid role source: ${String(role.source)}`);
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function sanitizeRoleRefPart(value: string): string {
  return slugifyRoleRefPart(value) || "role";
}

function slugifyRoleRefPart(value: string): string {
  let output = "";
  let previousDash = false;
  for (const char of value.trim().toLowerCase()) {
    const allowed = (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_";
    if (allowed) {
      output += char;
      previousDash = false;
    } else if (output && !previousDash) {
      output += "-";
      previousDash = true;
    }
  }
  return output.endsWith("-") ? output.slice(0, -1) : output;
}

async function findMarkdownFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
        result.push(filePath);
      }
    }
  }
  await visit(rootDir);
  return result.sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function idFromMarkdownPath(rootDir: string, filePath: string): string {
  const withoutExt = relative(rootDir, filePath).slice(0, -extname(filePath).length);
  return withoutExt.split(sep).join("/");
}

export function parseRoleSpecMarkdown(
  text: string,
  input: {
    source: WritableRoleSource;
    id: string;
    sourcePath?: string;
    originKind?: RoleOriginKind;
  },
): RoleSpec {
  const now = nowIso();
  const parsed = parseFrontmatter(text);
  const frontmatter = parsed.frontmatter;
  const id =
    stringFrontmatter(frontmatter, "id") ?? stringFrontmatter(frontmatter, "name") ?? input.id;
  const source = normalizeRoleSource(frontmatter.source) ?? input.source;
  if (source === "builtin" || source === "extension")
    throw new Error("markdown role stores cannot load builtin or extension roles");
  const description =
    stringFrontmatter(frontmatter, "description") ?? firstMarkdownParagraph(parsed.body);
  const systemPrompt = parsed.body.trim();
  const origin = parseOrigin(frontmatter.origin) ?? {
    kind: input.originKind ?? "manual",
    sourcePath: input.sourcePath,
  };
  const role: RoleSpec = {
    ref: createRoleRef(source, id),
    id,
    source,
    description,
    systemPrompt,
    allowedTools:
      arrayFrontmatter(frontmatter, "allowedTools") ?? arrayFrontmatter(frontmatter, "tools"),
    origin,
    createdAt: stringFrontmatter(frontmatter, "createdAt") ?? now,
    updatedAt: stringFrontmatter(frontmatter, "updatedAt") ?? now,
  };
  validateRoleSpec(role);
  return role;
}

export function serializeRoleSpecMarkdown(role: RoleSpec): string {
  validateRoleSpec(role);
  const frontmatter: Record<string, unknown> = {
    id: role.id,
    description: role.description,
    source: role.source,
  };
  if (role.allowedTools?.length) frontmatter.allowedTools = role.allowedTools;
  if (role.origin) frontmatter.origin = role.origin;
  frontmatter.createdAt = role.createdAt;
  frontmatter.updatedAt = role.updatedAt;
  return `---\n${formatFrontmatter(frontmatter)}---\n\n${role.systemPrompt.trim()}\n`;
}

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + "\n---".length).replace(/^\r?\n/, "");
  return { frontmatter: parseSimpleYaml(raw), body };
}

function parseSimpleYaml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const parsedLine = parseYamlLine(line);
    if (!parsedLine) continue;
    const { key, rest } = parsedLine;
    if (key === "defaultModel" || key === "model")
      throw new Error("role spec model fields are not supported; use role model settings");
    if (!ROLE_FRONTMATTER_KEYS.has(key)) continue;
    if (!rest) {
      const values: string[] = [];
      const object: Record<string, string> = {};
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (!/^\s+/.test(next)) break;
        index += 1;
        const trimmed = next.trim();
        if (trimmed.startsWith("- ")) values.push(unquoteYaml(trimmed.slice(2).trim()));
        else {
          const nested = parseYamlLine(trimmed);
          if (nested) object[nested.key] = unquoteYaml(nested.rest.trim());
        }
      }
      out[key] = values.length > 0 ? values : Object.keys(object).length > 0 ? object : "";
      continue;
    }
    out[key] = parseYamlScalar(rest.trim());
  }
  return out;
}

function parseYamlLine(line: string): { key: string; rest: string } | undefined {
  const colonIndex = line.indexOf(":");
  if (colonIndex <= 0) return undefined;
  const key = line.slice(0, colonIndex);
  if (!isYamlKey(key)) return undefined;
  return { key, rest: line.slice(colonIndex + 1).trimStart() };
}

function isYamlKey(value: string): boolean {
  const first = value[0];
  if (!first || !isYamlKeyStart(first)) return false;
  for (const char of value.slice(1)) if (!isYamlKeyChar(char)) return false;
  return true;
}

function isYamlKeyStart(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

function isYamlKeyChar(char: string): boolean {
  return isYamlKeyStart(char) || (char >= "0" && char <= "9") || char === "-";
}

function parseYamlScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquoteYaml(item.trim()))
      .filter(Boolean);
  }
  return unquoteYaml(value);
}

function unquoteYaml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function formatFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${quoteYaml(formatYamlScalar(item))}`);
    } else if (value && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue !== undefined)
          lines.push(`  ${nestedKey}: ${quoteYaml(formatYamlScalar(nestedValue))}`);
      }
    } else {
      lines.push(`${key}: ${quoteYaml(formatYamlScalar(value))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatYamlScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  return JSON.stringify(value);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function stringFrontmatter(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayFrontmatter(frontmatter: Record<string, unknown>, key: string): string[] | undefined {
  const value = frontmatter[key];
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function parseOrigin(value: unknown): RoleOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Omit<Partial<RoleOrigin>, "kind"> & { kind?: unknown };
  const kind = normalizeRoleOriginKind(raw.kind);
  if (!kind) return undefined;
  return {
    kind,
    sourcePath: raw.sourcePath,
    note: raw.note,
  };
}

function normalizeRoleOriginKind(value: unknown): RoleOriginKind | undefined {
  return value === "manual" || value === "generated" || value === "builtin" || value === "extension"
    ? value
    : undefined;
}

function firstMarkdownParagraph(body: string): string {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return paragraph?.slice(0, 200) || "Reusable Pi role.";
}

export class RoleRunTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`role run timed out after ${timeoutMs}ms`);
    this.name = "RoleRunTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class RoleRunCancelledError extends Error {
  readonly reason: string | undefined;

  constructor(reason?: string) {
    super(reason ? `role run cancelled: ${reason}` : "role run cancelled");
    this.name = "RoleRunCancelledError";
    this.reason = reason;
  }
}

const activeRoleRuns = new Map<RoleRunRef, ActiveRoleRun>();
const DEFAULT_ROLE_RUN_CAPTURE_LIMIT_BYTES = 1024 * 1024;

interface BoundedOutputCapture {
  push(chunk: Buffer): void;
  text(): string;
}

function createBoundedOutputCapture(
  label: "stdout" | "stderr",
  limitBytes = DEFAULT_ROLE_RUN_CAPTURE_LIMIT_BYTES,
): BoundedOutputCapture {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let omittedBytes = 0;
  return {
    push(chunk: Buffer) {
      chunks.push(chunk);
      capturedBytes += chunk.length;
      while (capturedBytes > limitBytes && chunks.length > 0) {
        const excess = capturedBytes - limitBytes;
        const first = chunks[0]!;
        if (first.length <= excess) {
          chunks.shift();
          capturedBytes -= first.length;
          omittedBytes += first.length;
          continue;
        }
        chunks[0] = first.subarray(excess);
        capturedBytes -= excess;
        omittedBytes += excess;
      }
    },
    text() {
      const output = Buffer.concat(chunks).toString("utf8");
      if (omittedBytes === 0) return output;
      return `[pi-roles ${label} omitted first ${omittedBytes} bytes; showing last ${capturedBytes} bytes]\n${output}`;
    },
  };
}

export function listActiveRoleRuns(): ActiveRoleRun[] {
  return [...activeRoleRuns.values()];
}

export function cancelRoleRun(runRef: RoleRunRef, reason?: string): boolean {
  return activeRoleRuns.get(runRef)?.cancel(reason) ?? false;
}

export function normalizeRoleLaunchMode(value: unknown): RoleLaunchMode {
  if (value === undefined || value === null) return "fresh";
  if (value === "fresh" || value === "forked") return value;
  throw new Error(`unsupported role launch mode: ${formatUnknownValue(value)}`);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  )
    return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol")
    return value.description ? `symbol:${value.description}` : "symbol";
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

export function buildRoleRunPrompt(
  input: Pick<RoleRunCommandInput, "instruction" | "runGuidance">,
): string {
  return [input.runGuidance?.trim(), "Instruction:", input.instruction.trim()]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export function buildRoleRunArgs(input: RoleRunCommandInput): string[] {
  if (!input.roleRef) throw new Error("role run roleRef is required");
  if (!input.instruction.trim()) throw new Error("role run instruction is required");
  const launch = normalizeRoleLaunchMode(input.launch);
  if (input.noSession && launch === "forked") {
    throw new Error("noSession role runs cannot use forked launch");
  }
  const args = ["--print", "--mode", "json"];
  if (input.noSession) args.push("--no-session");
  if (input.model?.trim()) args.push("--model", input.model.trim());
  const allowedTools = normalizedToolAllowlist(input.allowedTools);
  if (allowedTools.length > 0) args.push("--tools", allowedTools.join(","));
  if (input.sessionDir) args.push("--session-dir", input.sessionDir);
  if (launch === "forked") {
    if (!input.forkFromSession?.trim())
      throw new Error("forked role launch requires forkFromSession");
    args.push("--fork", input.forkFromSession.trim());
  }
  args.push("--append-system-prompt", input.systemPrompt, buildRoleRunPrompt(input));
  return args;
}

function normalizedToolAllowlist(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  return value.map((tool) => tool.trim()).filter(Boolean);
}

export function roleRunChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const remainingDepth = parseRoleRunDepth(env[ROLE_RUN_DEPTH_ENV]);
  if (remainingDepth <= 0) {
    throw new Error(`${ROLE_RUN_DEPTH_ENV} exhausted; refusing to spawn nested role run`);
  }
  return {
    ...env,
    [ROLE_RUN_DEPTH_ENV]: String(remainingDepth - 1),
  };
}

function parseRoleRunDepth(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_ROLE_RUN_DEPTH;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${ROLE_RUN_DEPTH_ENV} must be an integer`);
  }
  return parsed;
}

export async function runRole(input: RoleRunLauncherInput): Promise<RoleRunResult> {
  if (input.signal?.aborted) throw new RoleRunCancelledError(abortSignalReason(input.signal));
  const launch = normalizeRoleLaunchMode(input.launch);
  const startedAt = input.now?.() ?? nowIso();
  const childEnv = roleRunChildEnv(input.env);
  const child = spawn(input.piCommand, buildRoleRunArgs(input), {
    cwd: input.cwd,
    env: childEnv,
    stdio: [input.stdinMode === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
  });
  input.onChildProcess?.(child, startedAt);
  const stdoutCapture = createBoundedOutputCapture("stdout");
  const stderrCapture = createBoundedOutputCapture("stderr");
  child.stdout?.on("data", (chunk: Buffer) => stdoutCapture.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrCapture.push(chunk));

  let cancellationReason: string | undefined;
  const activeRun: ActiveRoleRun = {
    ref: input.runRef,
    roleRef: input.roleRef,
    launch,
    model: input.model?.trim() || undefined,
    child,
    startedAt,
    cancel(reason?: string) {
      cancellationReason = reason;
      return child.kill("SIGTERM");
    },
  };
  activeRoleRuns.set(input.runRef, activeRun);

  const abort = () => activeRun.cancel(abortSignalReason(input.signal));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  try {
    const timeoutMs = input.timeoutMs ?? 600_000;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cb();
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cancellationReason = "timeout";
          input.onTimeout?.();
          child.kill("SIGTERM");
          settle(() => reject(new RoleRunTimeoutError(timeoutMs)));
        }, timeoutMs);
        timer.unref?.();
      }
      child.once("error", (error) => settle(() => reject(error)));
      child.once("close", (code) => {
        if (cancellationReason) settle(() => reject(new RoleRunCancelledError(cancellationReason)));
        else settle(() => resolve(code));
      });
    });

    const stdout = stdoutCapture.text();
    const stderr = stderrCapture.text();
    return {
      record: {
        ref: input.runRef,
        roleRef: input.roleRef,
        launch,
        model: input.model?.trim() || undefined,
        status: exitCode === 0 ? "succeeded" : "failed",
        instruction: input.instruction,
        startedAt,
        finishedAt: input.now?.() ?? nowIso(),
        sessionDir: input.sessionDir,
        forkFromSession: launch === "forked" ? input.forkFromSession?.trim() : undefined,
        errorMessage: exitCode === 0 ? undefined : `pi exited with code ${exitCode ?? "unknown"}`,
      },
      stdout,
      stderr,
      jsonEvents: parsePiJsonlEvents(stdout),
    };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    activeRoleRuns.delete(input.runRef);
  }
}

export function parsePiJsonlEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Pi may emit non-JSON diagnostics. Keep parser tolerant.
    }
  }
  return events;
}

function abortSignalReason(signal: AbortSignal | undefined): string {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return "abort";
}
