import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export type RoleSource = "builtin" | "project" | "user";
export type RoleOriginKind = "manual" | "generated" | "builtin";
export type RoleRef = `role:${string}`;
export type RoleRunRef = `run:${string}`;
export type RoleRunMode = "fresh" | "forked";

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
  defaultModel?: string;
  origin?: RoleOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSpecProposal {
  artifactRef?: string;
  id: string;
  source?: Exclude<RoleSource, "builtin">;
  description: string;
  systemPrompt: string;
  rationale: string;
  expectedUses: string[];
  allowedTools?: string[];
  defaultModel?: string;
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
  mode?: RoleRunMode;
  systemPrompt?: string;
  /** Concrete, user-confirmed Pi model to use for this run. */
  model?: string;
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
  onChildProcess?: (child: ChildProcess, startedAt: string) => void;
  onTimeout?: () => void;
}

export interface RoleRunResult {
  record: RoleRunRecord & {
    mode: RoleRunMode;
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
  mode: RoleRunMode;
  model?: string;
  child: ChildProcess;
  startedAt: string;
  cancel(reason?: string): boolean;
}

export const builtinRoleIds = ["scout", "planner", "worker", "reviewer", "oracle"] as const;
export type BuiltinRoleId = (typeof builtinRoleIds)[number];
export type BuiltinRoleProvider = (now: string) => readonly RoleSpec[];

export interface DefaultRoleRegistryOptions {
  now?: string;
  extraRoles?: readonly RoleSpec[];
}

const builtinRoleProviders = new Map<string, BuiltinRoleProvider>();

const ROLE_FRONTMATTER_KEYS = new Set([
  "id",
  "name",
  "description",
  "source",
  "allowedTools",
  "tools",
  "defaultModel",
  "model",
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
  return roleRefId(normalizeRoleRef(ref)).replace(/^(builtin-|project-|user-)/, "");
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
  if (value === "project") return "project";
  if (value === "user") return "user";
  return undefined;
}

export function createBuiltinRoles(now = nowIso()): RoleSpec[] {
  return [
    builtin(
      "scout",
      "Fast repo and context reconnaissance.",
      "You are a Spark scout. Gather context, identify relevant files and risks, do not edit files, use Spark ask tools for real ambiguities/blockers instead of only listing questions when a user decision is needed, and flag obviously placeholder/generic/stale Spark project or task names so they can be safely improved without changing refs.",
      now,
    ),
    builtin(
      "planner",
      "Turns context into concrete task plans.",
      "You are a Spark planner. Produce concrete plans and dependencies without editing files, use Spark ask tools for real ambiguities/blockers instead of only listing questions when a user decision is needed, treat user-reported repo behavior changes as implementation work rather than memory-only updates, and improve obviously placeholder/generic/stale Spark project or task display names only when the new name is clear and refs stay stable.",
      now,
    ),
    builtin(
      "worker",
      "Executes approved implementation tasks.",
      "You are a Spark worker. Implement only the assigned instruction, use Spark ask tools for blockers or missing requirements instead of only reporting questions, and when the user reports a concrete repo behavior change, fix the implementation instead of only recording a preference. Safely improve obviously placeholder/generic/stale Spark project or claimed-task @name/title when the current intent makes the better name clear while preserving refs and intentional user names.",
      now,
    ),
    builtin(
      "reviewer",
      "Reviews results and artifacts against task intent.",
      "You are a Spark reviewer. Verify claims from fresh context, return actionable findings, use Spark ask tools for blocking ambiguous intent instead of silently assuming it, and call out placeholder/generic/stale Spark project or task names only when a safe improvement is obvious and would preserve refs.",
      now,
    ),
    builtin(
      "oracle",
      "Challenges risky decisions before execution.",
      "You are a Spark oracle. Challenge assumptions, use Spark ask tools for missing blocking decisions when a concrete user choice is required, recommend the safest next move without editing files, and preserve intentional Spark project/task names unless a placeholder/generic/stale rename is plainly correct and ref-safe.",
      now,
    ),
  ];
}

export function registerBuiltinRoleProvider(id: string, provider: BuiltinRoleProvider): void {
  assertNonEmpty(id, "builtin role provider id");
  builtinRoleProviders.set(id, provider);
}

export function unregisterBuiltinRoleProvider(id: string): boolean {
  return builtinRoleProviders.delete(id);
}

export function createRegisteredBuiltinRoles(now = nowIso()): RoleSpec[] {
  const roles: RoleSpec[] = [];
  for (const [id, provider] of [...builtinRoleProviders.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const role of provider(now)) {
      if (role.source !== "builtin")
        throw new Error(`builtin role provider ${id} returned non-builtin role: ${role.id}`);
      roles.push(role);
    }
  }
  return roles;
}

export function createDefaultRoleRegistry(options: DefaultRoleRegistryOptions = {}): RoleRegistry {
  const now = options.now ?? nowIso();
  return new RoleRegistry([
    ...createBuiltinRoles(now),
    ...createRegisteredBuiltinRoles(now),
    ...(options.extraRoles ?? []),
  ]);
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
  source: Exclude<RoleSource, "builtin">;
  writable?: boolean;
  originKind?: RoleOriginKind;
}

export class MarkdownRoleStore implements RoleStore {
  readonly rootDir: string;
  readonly source: Exclude<RoleSource, "builtin">;
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

export interface RoleModelBinding {
  roleRef: RoleRef;
  model: string;
  source: "user";
  validatedAt: string;
  updatedAt: string;
  validationCommand: string;
}

interface RoleModelBindingFile {
  version: 1;
  bindings: RoleModelBinding[];
}

export class RoleModelBindingStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid role model binding store: ${filePath}: ${message}`);
    this.name = "RoleModelBindingStoreFormatError";
    this.filePath = filePath;
  }
}

export class RoleModelBindingStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async loadAll(): Promise<RoleModelBinding[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = parseRoleModelBindingFileJson(raw, this.filePath);
    assertRoleModelBindingFile(parsed, this.filePath);
    return parsed.bindings;
  }

  async get(roleRef: string): Promise<RoleModelBinding | undefined> {
    const normalized = normalizeRoleRef(roleRef);
    return (await this.loadAll()).find((binding) => binding.roleRef === normalized);
  }

  async save(binding: RoleModelBinding): Promise<void> {
    if (!binding.model.trim()) throw new Error("role model binding model is required");
    const normalized: RoleModelBinding = {
      ...binding,
      roleRef: normalizeRoleRef(binding.roleRef),
      model: binding.model.trim(),
    };
    const bindings = (await this.loadAll()).filter((entry) => entry.roleRef !== normalized.roleRef);
    bindings.push(normalized);
    bindings.sort((a, b) => a.roleRef.localeCompare(b.roleRef));
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteRoleModelBindingFile(
      this.filePath,
      `${JSON.stringify({ version: 1, bindings } satisfies RoleModelBindingFile, null, 2)}\n`,
    );
  }
}

export function defaultUserRoleModelBindingStore(
  home = process.env.PI_ROLES_HOME || homedir(),
): RoleModelBindingStore {
  return new RoleModelBindingStore(join(home, ".agents", "role-model-bindings.json"));
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

function parseRoleModelBindingFileJson(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RoleModelBindingStoreFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function atomicWriteRoleModelBindingFile(filePath: string, data: string): Promise<void> {
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
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

function assertRoleModelBindingFile(
  value: unknown,
  filePath: string,
): asserts value is RoleModelBindingFile {
  if (!isRecord(value)) {
    throw new RoleModelBindingStoreFormatError(filePath, "JSON root must be an object");
  }
  if (value.version !== 1) {
    throw new RoleModelBindingStoreFormatError(filePath, "version must be 1");
  }
  if (!Array.isArray(value.bindings)) {
    throw new RoleModelBindingStoreFormatError(filePath, "bindings must be an array");
  }
  value.bindings.forEach((binding, index) => {
    assertRoleModelBinding(binding, filePath, index);
  });
}

function assertRoleModelBinding(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is RoleModelBinding {
  if (!isRecord(value)) {
    throw new RoleModelBindingStoreFormatError(filePath, `bindings[${index}] must be an object`);
  }
  if (typeof value.roleRef !== "string" || !value.roleRef.startsWith("role:")) {
    throw new RoleModelBindingStoreFormatError(
      filePath,
      `bindings[${index}].roleRef must be a role ref`,
    );
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new RoleModelBindingStoreFormatError(
      filePath,
      `bindings[${index}].model must be a non-empty string`,
    );
  }
  if (value.source !== "user") {
    throw new RoleModelBindingStoreFormatError(filePath, `bindings[${index}].source must be user`);
  }
  if (typeof value.validatedAt !== "string") {
    throw new RoleModelBindingStoreFormatError(
      filePath,
      `bindings[${index}].validatedAt must be a string`,
    );
  }
  if (typeof value.updatedAt !== "string") {
    throw new RoleModelBindingStoreFormatError(
      filePath,
      `bindings[${index}].updatedAt must be a string`,
    );
  }
  if (typeof value.validationCommand !== "string") {
    throw new RoleModelBindingStoreFormatError(
      filePath,
      `bindings[${index}].validationCommand must be a string`,
    );
  }
}

export async function saveValidatedRoleModelBinding(input: {
  store?: RoleModelBindingStore;
  roleRef: RoleRef;
  model: string;
  piCommand: string;
  cwd?: string;
  now?: () => string;
}): Promise<RoleModelBinding> {
  await validateRoleModel({ piCommand: input.piCommand, model: input.model, cwd: input.cwd });
  const now = input.now?.() ?? nowIso();
  const binding: RoleModelBinding = {
    roleRef: normalizeRoleRef(input.roleRef),
    model: input.model.trim(),
    source: "user",
    validatedAt: now,
    updatedAt: now,
    validationCommand: `${input.piCommand} --list-models ${input.model.trim()}`,
  };
  await (input.store ?? defaultUserRoleModelBindingStore()).save(binding);
  return binding;
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
    defaultModel: proposal.defaultModel,
    origin: proposal.origin,
    createdAt: now,
    updatedAt: now,
  };
}

export function createRoleRef(source: RoleSource, id: string): RoleRef {
  if (source === "builtin") return `role:builtin-${sanitizeRoleRefPart(id)}`;
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
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "role"
  );
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
  return result.sort();
}

function idFromMarkdownPath(rootDir: string, filePath: string): string {
  const withoutExt = relative(rootDir, filePath).slice(0, -extname(filePath).length);
  return withoutExt.split(sep).join("/");
}

export function parseRoleSpecMarkdown(
  text: string,
  input: {
    source: Exclude<RoleSource, "builtin">;
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
  if (source === "builtin") throw new Error("markdown role stores cannot load builtin roles");
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
    defaultModel:
      stringFrontmatter(frontmatter, "defaultModel") ?? stringFrontmatter(frontmatter, "model"),
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
  if (role.defaultModel) frontmatter.defaultModel = role.defaultModel;
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
    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
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
          const nested = /^(\w[\w-]*):\s*(.*)$/.exec(trimmed);
          if (nested) object[nested[1]] = unquoteYaml(nested[2].trim());
        }
      }
      out[key] = values.length > 0 ? values : Object.keys(object).length > 0 ? object : "";
      continue;
    }
    out[key] = parseYamlScalar(rest.trim());
  }
  return out;
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
  return value === "manual" || value === "generated" || value === "builtin" ? value : undefined;
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
const DEFAULT_ROLE_RUN_CAPTURE_LIMIT_BYTES = 8 * 1024 * 1024;

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
  let droppedBytes = 0;
  return {
    push(chunk: Buffer) {
      const remaining = Math.max(0, limitBytes - capturedBytes);
      if (remaining > 0) {
        const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(captured);
        capturedBytes += captured.length;
      }
      if (chunk.length > remaining) droppedBytes += chunk.length - remaining;
    },
    text() {
      const output = Buffer.concat(chunks).toString("utf8");
      if (droppedBytes === 0) return output;
      return `${output}\n[pi-roles ${label} truncated after ${capturedBytes} bytes; dropped ${droppedBytes} bytes]\n`;
    },
  };
}

export function listActiveRoleRuns(): ActiveRoleRun[] {
  return [...activeRoleRuns.values()];
}

export function cancelRoleRun(runRef: RoleRunRef, reason?: string): boolean {
  return activeRoleRuns.get(runRef)?.cancel(reason) ?? false;
}

export function normalizeRoleRunMode(value: unknown): RoleRunMode {
  if (value === undefined || value === null) return "fresh";
  if (value === "fresh" || value === "forked") return value;
  throw new Error(`unsupported role run mode: ${formatUnknownValue(value)}`);
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
  const mode = normalizeRoleRunMode(input.mode);
  const args = ["--print", "--mode", "json"];
  if (input.model?.trim()) args.push("--model", input.model.trim());
  if (input.sessionDir) args.push("--session-dir", input.sessionDir);
  if (mode === "forked") {
    if (!input.forkFromSession?.trim()) throw new Error("forked role run requires forkFromSession");
    args.push("--fork", input.forkFromSession.trim());
  }
  args.push("--append-system-prompt", input.systemPrompt, buildRoleRunPrompt(input));
  return args;
}

export async function runRole(input: RoleRunLauncherInput): Promise<RoleRunResult> {
  if (input.signal?.aborted) throw new RoleRunCancelledError(abortSignalReason(input.signal));
  const mode = normalizeRoleRunMode(input.mode);
  const startedAt = input.now?.() ?? nowIso();
  const child = spawn(input.piCommand, buildRoleRunArgs(input), {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  input.onChildProcess?.(child, startedAt);
  const stdoutCapture = createBoundedOutputCapture("stdout");
  const stderrCapture = createBoundedOutputCapture("stderr");
  child.stdout.on("data", (chunk: Buffer) => stdoutCapture.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrCapture.push(chunk));

  let cancellationReason: string | undefined;
  const activeRun: ActiveRoleRun = {
    ref: input.runRef,
    roleRef: input.roleRef,
    mode,
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
        mode,
        model: input.model?.trim() || undefined,
        status: exitCode === 0 ? "succeeded" : "failed",
        instruction: input.instruction,
        startedAt,
        finishedAt: input.now?.() ?? nowIso(),
        sessionDir: input.sessionDir,
        forkFromSession: mode === "forked" ? input.forkFromSession?.trim() : undefined,
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
