import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createId } from "@navia-dev/protocol";
import { parse, stringify } from "smol-toml";

export const workspaceProfileSchemaVersion = "navia.profile/v1";
export const freshProfileId = "builtin:fresh";

export type ProfileInputType = "string";
export type ProfileSourceKind = "builtin" | "git";

export interface WorkspaceProfileInputSpec {
  type: ProfileInputType;
  required: boolean;
  default?: string;
  defaultFrom?: string;
}

export interface WorkspaceProfileAgentSpec {
  name: string;
  description: string | null;
  source: "builtin" | "workspace" | "imported";
  status: "active" | "disabled" | "archived";
  config: Record<string, unknown>;
}

export interface WorkspaceProfileResourceSpec {
  name: string;
  kind: "repo" | "doc" | "url" | "file" | "secret_ref" | "tool" | "other";
  uri: string | null;
  status: "available" | "degraded" | "unavailable" | "archived";
  config: Record<string, unknown>;
}

export interface WorkspaceProfileSource {
  kind: ProfileSourceKind;
  path: string | null;
  repoUrl: string | null;
  commitHash: string | null;
}

export interface WorkspaceProfileDefinition {
  schemaVersion: typeof workspaceProfileSchemaVersion;
  profile: {
    id: string;
    name: string;
    description: string | null;
  };
  inputs: Record<string, WorkspaceProfileInputSpec>;
  settings: Record<string, unknown>;
  agents: WorkspaceProfileAgentSpec[];
  resources: WorkspaceProfileResourceSpec[];
  source: WorkspaceProfileSource;
}

export interface GitHubProfileUrl {
  cloneUrl: string;
  webUrl: string;
  ref: string | null;
  sourcePath: string | null;
}

export interface ResolvedWorkspaceProfileInputs {
  values: Record<string, string>;
  workspaceName: string;
  workspaceSlug: string;
}

export function builtinFreshWorkspaceProfile(): WorkspaceProfileDefinition {
  return {
    schemaVersion: workspaceProfileSchemaVersion,
    profile: {
      id: freshProfileId,
      name: "Fresh workspace",
      description: "An empty Navia workspace profile.",
    },
    inputs: {
      workspaceName: { type: "string", required: true },
      workspaceSlug: {
        type: "string",
        required: true,
        defaultFrom: "workspaceName",
      },
    },
    settings: {},
    agents: [],
    resources: [],
    source: { kind: "builtin", path: null, repoUrl: null, commitHash: null },
  };
}

export function loadWorkspaceProfileFromDirectory(profilePath: string): WorkspaceProfileDefinition {
  const root = resolve(profilePath);
  const settingsPath = join(root, "settings.toml");
  if (!existsSync(settingsPath)) {
    throw new Error(`Profile settings.toml was not found: ${settingsPath}`);
  }

  const settings = parseTomlObject(settingsPath);
  const schemaVersion = readString(settings.schemaVersion, "settings.toml schemaVersion");
  if (schemaVersion !== workspaceProfileSchemaVersion) {
    throw new Error(`Unsupported profile schemaVersion: ${schemaVersion}`);
  }

  const profile = readObject(settings.profile, "settings.toml [profile]");
  const inputs = readInputs(settings.inputs);

  return {
    schemaVersion: workspaceProfileSchemaVersion,
    profile: {
      id: readString(profile.id, "settings.toml profile.id"),
      name: readString(profile.name, "settings.toml profile.name"),
      description: readOptionalString(profile.description, "settings.toml profile.description"),
    },
    inputs,
    settings: readOptionalObject(settings.settings, "settings.toml [settings]"),
    agents: readAgentSpecs(join(root, "agents")),
    resources: readProfileEntries(join(root, "repos"), parseResourceSpec),
    source: {
      kind: "git",
      path: root,
      repoUrl: gitOutput(root, ["config", "--get", "remote.origin.url"]),
      commitHash: gitOutput(root, ["rev-parse", "HEAD"]),
    },
  };
}

export function loadWorkspaceProfileFromGitHubUrl(profileUrl: string): WorkspaceProfileDefinition {
  const parsed = parseGitHubProfileUrl(profileUrl);
  const checkoutRoot = mkdtempSync(join(tmpdir(), "navia-profile-"));

  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (parsed.ref) {
      cloneArgs.push("--branch", parsed.ref);
    }
    cloneArgs.push(parsed.cloneUrl, checkoutRoot);
    execFileSync("git", cloneArgs, { stdio: ["ignore", "pipe", "pipe"] });

    const profileRoot = parsed.sourcePath ? join(checkoutRoot, parsed.sourcePath) : checkoutRoot;
    const profile = loadWorkspaceProfileFromDirectory(profileRoot);
    return {
      ...profile,
      source: {
        kind: "git",
        path: parsed.sourcePath,
        repoUrl: parsed.webUrl,
        commitHash: gitOutput(checkoutRoot, ["rev-parse", "HEAD"]),
      },
    };
  } finally {
    rmSync(checkoutRoot, { recursive: true, force: true });
  }
}

export function parseGitHubProfileUrl(profileUrl: string): GitHubProfileUrl {
  let url: URL;
  try {
    url = new URL(profileUrl);
  } catch {
    throw new Error("Profile must be a GitHub repository or tree URL.");
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("Profile must be an https://github.com/... URL.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repoSegment = segments[1];
  if (!owner || !repoSegment) {
    throw new Error("Profile URL must include a GitHub owner and repository.");
  }

  const repo = repoSegment.replace(/\.git$/, "");
  const rest = segments.slice(2);
  let ref: string | null = null;
  let sourcePath: string | null = null;

  if (rest.length > 0) {
    if (rest[0] !== "tree" || !rest[1]) {
      throw new Error("Profile URL must point to a GitHub repository or tree path.");
    }
    ref = rest[1];
    sourcePath = rest.slice(2).join("/") || null;
  }

  return {
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    webUrl: `https://github.com/${owner}/${repo}`,
    ref,
    sourcePath,
  };
}

export function resolveWorkspaceProfileInputs(
  profile: WorkspaceProfileDefinition,
  rawValues: Record<string, string | null | undefined>,
): ResolvedWorkspaceProfileInputs {
  const values: Record<string, string> = {};

  for (const [key, spec] of Object.entries(profile.inputs)) {
    const rawValue = rawValues[key]?.trim();
    const defaultValue = spec.default?.trim();
    const defaultFrom = spec.defaultFrom ? values[spec.defaultFrom] : undefined;
    let value = rawValue || defaultValue || defaultFrom || "";

    if (spec.defaultFrom && key.toLowerCase().includes("slug") && !rawValue && defaultFrom) {
      value = slugify(defaultFrom);
    }

    if (spec.required && !value) {
      throw new Error(`Missing required profile input: ${key}`);
    }

    if (value) {
      values[key] = value;
    }
  }

  const workspaceName = values.workspaceName ?? rawValues.workspaceName?.trim();
  const workspaceSlug = values.workspaceSlug ?? slugify(workspaceName ?? "");
  if (!workspaceName || !workspaceSlug) {
    throw new Error("Profile must resolve workspaceName and workspaceSlug.");
  }

  return { values, workspaceName, workspaceSlug };
}

export interface RecordProfileGitAccessInput {
  workspaceProfileSourceId: string;
  canRead: boolean;
  canPull: boolean;
  canPush: boolean;
  reason?: string | null;
  checkedAt?: string;
}

export function recordWorkspaceProfileGitAccess(
  db: DatabaseSync,
  input: RecordProfileGitAccessInput,
) {
  const now = new Date().toISOString();
  const checkedAt = input.checkedAt ?? now;
  const existing = db
    .prepare(
      `SELECT id
       FROM workspace_profile_git_access
       WHERE workspace_profile_source_id = ?
       LIMIT 1`,
    )
    .get(input.workspaceProfileSourceId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE workspace_profile_git_access
       SET can_read = ?, can_pull = ?, can_push = ?, reason = ?, checked_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.canRead ? 1 : 0,
      input.canPull ? 1 : 0,
      input.canPush ? 1 : 0,
      input.reason ?? null,
      checkedAt,
      now,
      existing.id,
    );

    return { id: existing.id, checkedAt };
  }

  const id = createId("wpga");
  db.prepare(
    `INSERT INTO workspace_profile_git_access
      (id, workspace_profile_source_id, can_read, can_pull, can_push, reason, checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceProfileSourceId,
    input.canRead ? 1 : 0,
    input.canPull ? 1 : 0,
    input.canPush ? 1 : 0,
    input.reason ?? null,
    checkedAt,
    now,
    now,
  );

  return { id, checkedAt };
}

export function exportWorkspaceProfileToml(db: DatabaseSync, workspaceId: string) {
  const workspace = db
    .prepare(
      `SELECT slug, name, description, settings_json AS settingsJson
       FROM workspaces
       WHERE id = ?
       LIMIT 1`,
    )
    .get(workspaceId) as
    | {
        slug: string;
        name: string;
        description: string | null;
        settingsJson: string;
      }
    | undefined;

  if (!workspace) {
    throw new Error(`Workspace was not found: ${workspaceId}`);
  }

  const files = new Map<string, string>();
  files.set(
    "settings.toml",
    stringify({
      schemaVersion: workspaceProfileSchemaVersion,
      profile: {
        id: workspace.slug,
        name: workspace.name,
        description: workspace.description ?? undefined,
      },
      inputs: {
        workspaceName: { type: "string", required: true },
        workspaceSlug: {
          type: "string",
          required: true,
          defaultFrom: "workspaceName",
        },
      },
      settings: parseJsonObject(workspace.settingsJson),
    }),
  );

  const agents = db
    .prepare(
      `SELECT name, source, status, description, config_json AS configJson
       FROM agent_specs
       WHERE workspace_id = ?
         AND status != 'archived'
       ORDER BY name ASC`,
    )
    .all(workspaceId) as Array<{
    name: string;
    source: string;
    status: string;
    description: string | null;
    configJson: string;
  }>;

  for (const agent of agents) {
    const config = parseJsonObject(agent.configJson);
    const agentId = readRequiredId(config.id, `agent ${agent.name} config.id`);
    const promptContents = readPromptContents(config);
    const agentToml = agentTomlDocument({
      name: agent.name,
      source: agent.source,
      status: agent.status,
      description: agent.description,
      config,
    });

    files.set(`agents/${agentId}/agent.toml`, stringify(agentToml));

    for (const [fileName, content] of Object.entries(promptContents)) {
      files.set(`agents/${agentId}/${fileName}`, content);
    }
  }

  const resources = db
    .prepare(
      `SELECT name, kind, uri, status, config_json AS configJson
       FROM resources
       WHERE workspace_id = ?
         AND status != 'archived'
       ORDER BY name ASC`,
    )
    .all(workspaceId) as Array<{
    name: string;
    kind: string;
    uri: string | null;
    status: string;
    configJson: string;
  }>;

  for (const resource of resources) {
    const config = parseJsonObject(resource.configJson);
    const resourceId = readRequiredId(config.id, `resource ${resource.name} config.id`);
    files.set(
      `repos/${resourceId}.toml`,
      stringify(
        resourceTomlDocument({
          name: resource.name,
          kind: resource.kind,
          uri: resource.uri ?? undefined,
          status: resource.status,
          config,
        }),
      ),
    );
  }

  return files;
}

function readAgentSpecs(directory: string): WorkspaceProfileAgentSpec[] {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isFile() && entry.name.endsWith(".toml")) {
        throw new Error(
          `Flat agent TOML is not supported. Use agents/${entry.name.replace(/\.toml$/i, "")}/agent.toml.`,
        );
      }

      if (entry.isDirectory()) {
        const agentFile = join(directory, entry.name, "agent.toml");
        if (existsSync(agentFile)) {
          return [{ filePath: agentFile, sortKey: `${entry.name}/agent.toml` }];
        }
      }

      return [];
    })
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));

  const seen = new Set<string>();
  const agents: WorkspaceProfileAgentSpec[] = [];
  for (const entry of entries) {
    const agent = parseAgentSpec(entry.filePath);
    if (seen.has(agent.name)) {
      throw new Error(`Duplicate agent name in profile: ${agent.name}`);
    }
    seen.add(agent.name);
    agents.push(agent);
  }

  return agents;
}

function readProfileEntries<T>(directory: string, parser: (path: string) => T): T[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((file) => file.endsWith(".toml"))
    .sort()
    .map((file) => parser(join(directory, file)));
}

function parseAgentSpec(path: string): WorkspaceProfileAgentSpec {
  const value = parseTomlObject(path);
  const agentDir = basename(path) === "agent.toml" ? dirname(path) : null;
  if (!agentDir) {
    throw new Error(`Agent definitions must use agents/<id>/agent.toml: ${path}`);
  }

  const id = readRequiredId(value.id, `${basename(path)} id`);
  const prompts = value.prompts === undefined ? {} : readAgentPrompts(agentDir, value.prompts);
  const config = mergeConfig(
    collectKnownConfig(value, agentConfigKeys),
    readOptionalObject(value.config, `${basename(path)} [config]`),
  );

  config.id = id;
  if (Object.keys(prompts).length > 0) {
    config.prompts = prompts;
  }

  return {
    name: readString(value.name, `${basename(path)} name`),
    description: readOptionalString(value.description, `${basename(path)} description`),
    source: readRequiredEnum(
      value.source,
      ["builtin", "workspace", "imported"],
      `${basename(path)} source`,
    ),
    status: readRequiredEnum(
      value.status,
      ["active", "disabled", "archived"],
      `${basename(path)} status`,
    ),
    config,
  };
}

function parseResourceSpec(path: string): WorkspaceProfileResourceSpec {
  const value = parseTomlObject(path);
  const id = readRequiredId(value.id, `${basename(path)} id`);
  const config = mergeConfig(
    { id, ...collectKnownConfig(value, resourceConfigKeys) },
    readOptionalObject(value.config, `${basename(path)} [config]`),
  );

  return {
    name: readString(value.name, `${basename(path)} name`),
    kind: readRequiredEnum(
      value.kind,
      ["repo", "doc", "url", "file", "secret_ref", "tool", "other"],
      `${basename(path)} kind`,
    ),
    uri: readOptionalString(value.uri, `${basename(path)} uri`),
    status: readRequiredEnum(
      value.status,
      ["available", "degraded", "unavailable", "archived"],
      `${basename(path)} status`,
    ),
    config,
  };
}

const agentConfigKeys = [
  "id",
  "role",
  "tools",
  "spawns",
  "model",
  "skills",
  "output",
  "blocking",
  "prompts",
] as const;

const resourceConfigKeys = [
  "id",
  "provider",
  "defaultBranch",
  "roles",
  "trust",
  "checkout",
  "sync",
  "permissions",
  "metadata",
] as const;

function collectKnownConfig(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      result[key] = value[key];
    }
  }
  return result;
}

function mergeConfig(
  preferred: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  return compactObject({ ...base, ...preferred });
}

function readAgentPrompts(agentDir: string, rawPrompts: unknown) {
  const promptConfig = readObject(rawPrompts, `${basename(agentDir)} [prompts]`);
  const declaredFiles = readOptionalStringArray(
    promptConfig.files,
    `${basename(agentDir)} prompts.files`,
  );
  if (!declaredFiles || declaredFiles.length === 0) {
    throw new Error(`${basename(agentDir)} prompts.files must declare at least one file.`);
  }
  const promptFiles = declaredFiles;
  const contents: Record<string, string> = {};

  for (const fileName of promptFiles) {
    if (fileName.includes("/") || fileName.includes("\\")) {
      throw new Error(`Agent prompt file must be relative to its agent directory: ${fileName}`);
    }

    const filePath = join(agentDir, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`Agent prompt file was declared but not found: ${filePath}`);
    }
    contents[fileName] = readFileSync(filePath, "utf8");
  }

  return compactObject({
    ...promptConfig,
    files: promptFiles.length > 0 ? promptFiles : undefined,
    contents: Object.keys(contents).length > 0 ? contents : undefined,
  });
}

function agentTomlDocument(input: {
  name: string;
  source: string;
  status: string;
  description: string | null;
  config: Record<string, unknown>;
}) {
  const config = { ...input.config };
  const known = takeKnownConfig(config, agentConfigKeys);
  const prompts = readObjectIfRecord(known.prompts);
  if (prompts) {
    delete prompts.contents;
    if (Object.keys(prompts).length > 0) {
      known.prompts = prompts;
    } else {
      delete known.prompts;
    }
  }

  return compactObject({
    id: known.id,
    name: input.name,
    source: input.source,
    status: input.status,
    description: input.description ?? undefined,
    ...known,
    config: Object.keys(config).length > 0 ? config : undefined,
  });
}

function resourceTomlDocument(input: {
  name: string;
  kind: string;
  uri: string | undefined;
  status: string;
  config: Record<string, unknown>;
}) {
  const config = { ...input.config };
  const known = takeKnownConfig(config, resourceConfigKeys);

  return compactObject({
    id: known.id,
    name: input.name,
    kind: input.kind,
    uri: input.uri,
    status: input.status,
    ...known,
    config: Object.keys(config).length > 0 ? config : undefined,
  });
}

function takeKnownConfig(
  config: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (config[key] !== undefined) {
      result[key] = config[key];
      delete config[key];
    }
  }
  return result;
}

function readPromptContents(config: Record<string, unknown>) {
  const prompts = readObjectIfRecord(config.prompts);
  const contents = readObjectIfRecord(prompts?.contents);
  const result: Record<string, string> = {};

  if (!contents) {
    return result;
  }

  for (const [fileName, content] of Object.entries(contents)) {
    if (
      typeof content === "string" &&
      fileName &&
      !fileName.includes("/") &&
      !fileName.includes("\\")
    ) {
      result[fileName] = content;
    }
  }

  return result;
}

function readInputs(value: unknown): Record<string, WorkspaceProfileInputSpec> {
  const inputs = readObject(value, "settings.toml [inputs]");
  const result: Record<string, WorkspaceProfileInputSpec> = {};

  for (const [key, rawSpec] of Object.entries(inputs)) {
    const spec = readObject(rawSpec, `settings.toml [inputs.${key}]`);
    const type = readRequiredEnum(spec.type, ["string"], `settings.toml inputs.${key}.type`);
    result[key] = {
      type,
      required: readBoolean(spec.required, `settings.toml inputs.${key}.required`),
      default: readOptionalString(spec.default, `settings.toml inputs.${key}.default`) ?? undefined,
      defaultFrom:
        readOptionalString(spec.defaultFrom, `settings.toml inputs.${key}.defaultFrom`) ??
        undefined,
    };
  }

  return result;
}

function parseTomlObject(path: string) {
  try {
    return readObject(parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a TOML table.`);
  }

  return value as Record<string, unknown>;
}

function readOptionalObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  return readObject(value, label);
}

function readString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  return value.trim() || null;
}

function readOptionalStringArray(value: unknown, label: string) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function readBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function readRequiredEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }

  return value as T;
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readObjectIfRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readRequiredId(value: unknown, label: string) {
  const id = readString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`${label} must use only letters, numbers, dots, underscores, or dashes.`);
  }

  return id;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) {
      continue;
    }
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Object.keys(item).length === 0
    ) {
      continue;
    }
    result[key] = item;
  }

  return result as T;
}

function gitOutput(root: string, args: string[]) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
