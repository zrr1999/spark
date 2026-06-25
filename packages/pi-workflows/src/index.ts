import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  getBuiltinWorkflowDefinition,
  listBuiltinWorkflows,
  type BuiltinWorkflowMode,
} from "./builtins.ts";
import { parseWorkflowScript } from "./metadata.ts";

export type WorkflowSource = "builtin" | "workspace" | "user";
export type WorkflowSelector = `${WorkflowSource}:${string}`;

export interface WorkflowDescriptor {
  selector: WorkflowSelector;
  id: string;
  source: WorkflowSource;
  title: string;
  description: string;
  path: string;
  stages: string[];
  /** @deprecated Use stages. */
  phases: string[];
  mode?: BuiltinWorkflowMode;
}

export interface WorkflowRegistryError {
  source: WorkflowSource;
  path: string;
  error: string;
}

export interface WorkflowRegistryListing {
  workflows: WorkflowDescriptor[];
  errors: WorkflowRegistryError[];
}

export interface WorkflowRegistryOptions {
  includeUser?: boolean;
  workspaceWorkflowDir?: string;
  userWorkflowDir?: string;
}

export function normalizeWorkflowId(id: string): string {
  const normalized = id.trim().replaceAll("_", "-");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
    throw new Error("workflow id must be lowercase letters, digits, and hyphens");
  }
  return normalized;
}

export function workflowSelector(source: WorkflowSource, id: string): WorkflowSelector {
  return `${source}:${normalizeWorkflowId(id)}`;
}

export function workspaceWorkflowDir(cwd: string): string {
  return join(cwd, ".spark", "workflows");
}

export function userWorkflowDir(): string {
  return join(homedir(), ".agents", "workflows");
}

export async function listSavedWorkflows(
  cwd: string,
  options: WorkflowRegistryOptions = {},
): Promise<WorkflowRegistryListing> {
  const includeUser = options.includeUser ?? true;
  const builtins = discoverBuiltinWorkflows();
  const workspace = await discoverWorkflowDir(
    "workspace",
    options.workspaceWorkflowDir ?? workspaceWorkflowDir(cwd),
  );
  const user = includeUser
    ? await discoverWorkflowDir("user", options.userWorkflowDir ?? userWorkflowDir())
    : { workflows: [], errors: [] };
  return {
    workflows: [...builtins.workflows, ...workspace.workflows, ...user.workflows],
    errors: [...builtins.errors, ...workspace.errors, ...user.errors],
  };
}

export async function readSavedWorkflow(input: {
  cwd: string;
  selector: string;
  includeUser?: boolean;
  workspaceWorkflowDir?: string;
  userWorkflowDir?: string;
}): Promise<{ descriptor: WorkflowDescriptor; script: string }> {
  const selector = parseWorkflowSelector(input.selector);
  if (selector.source === "builtin") {
    const definition = getBuiltinWorkflowDefinition(selector.id);
    if (!definition) throw new Error(`unknown builtin workflow: ${selector.id}`);
    const script = definition.scriptFactory();
    const meta = parseWorkflowScript(script).meta;
    return {
      descriptor: {
        selector: workflowSelector("builtin", selector.id),
        id: selector.id,
        source: "builtin",
        title: meta.name,
        description: meta.description,
        path: workflowSelector("builtin", selector.id),
        stages: workflowStageTitles(meta),
        phases: workflowStageTitles(meta),
        mode: definition.mode,
      },
      script,
    };
  }
  if (selector.source === "user" && input.includeUser === false) {
    throw new Error("user workflows are disabled for this read");
  }
  const dir =
    selector.source === "workspace"
      ? (input.workspaceWorkflowDir ?? workspaceWorkflowDir(input.cwd))
      : (input.userWorkflowDir ?? userWorkflowDir());
  const path = join(dir, `${selector.id}.js`);
  if (basename(path) !== `${selector.id}.js`) throw new Error("workflow selector escaped root");
  const script = await readFile(path, "utf8");
  const meta = parseWorkflowScript(script).meta;
  return {
    descriptor: {
      selector: workflowSelector(selector.source, selector.id),
      id: selector.id,
      source: selector.source,
      title: meta.name,
      description: meta.description,
      path,
      stages: workflowStageTitles(meta),
      phases: workflowStageTitles(meta),
    },
    script,
  };
}

function parseWorkflowSelector(selector: string): { source: WorkflowSource; id: string } {
  const [source, rawId, ...rest] = selector.split(":");
  if (
    rest.length > 0 ||
    (source !== "builtin" && source !== "workspace" && source !== "user") ||
    !rawId
  ) {
    throw new Error("workflow selector must be builtin:<id>, workspace:<id>, or user:<id>");
  }
  return { source, id: normalizeWorkflowId(rawId) };
}

function discoverBuiltinWorkflows(): WorkflowRegistryListing {
  const workflows: WorkflowDescriptor[] = [];
  const errors: WorkflowRegistryError[] = [];
  for (const definition of listBuiltinWorkflows()) {
    try {
      const id = normalizeWorkflowId(definition.id);
      const script = definition.scriptFactory();
      const meta = parseWorkflowScript(script).meta;
      workflows.push({
        selector: workflowSelector("builtin", id),
        id,
        source: "builtin",
        title: meta.name,
        description: meta.description,
        path: workflowSelector("builtin", id),
        stages: workflowStageTitles(meta),
        phases: workflowStageTitles(meta),
        mode: definition.mode,
      });
    } catch (error) {
      errors.push({
        source: "builtin",
        path: workflowSelector("builtin", definition.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { workflows, errors };
}

async function discoverWorkflowDir(
  source: WorkflowSource,
  dir: string,
): Promise<WorkflowRegistryListing> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { workflows: [], errors: [] };
    throw error;
  }
  const workflows: WorkflowDescriptor[] = [];
  const errors: WorkflowRegistryError[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".js")).sort(compareStrings)) {
    const path = join(dir, entry);
    const id = entry.replace(/\.js$/u, "");
    try {
      const script = await readFile(path, "utf8");
      const meta = parseWorkflowScript(script).meta;
      workflows.push({
        selector: workflowSelector(source, id),
        id: normalizeWorkflowId(id),
        source,
        title: meta.name,
        description: meta.description,
        path,
        stages: workflowStageTitles(meta),
        phases: workflowStageTitles(meta),
      });
    } catch (error) {
      errors.push({ source, path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { workflows, errors };
}

function workflowStageTitles(meta: {
  stages?: Array<{ title: string }>;
  phases?: Array<{ title: string }>;
}): string[] {
  return (meta.stages ?? meta.phases ?? []).map((stage) => stage.title);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

export * from "./types.ts";
export * from "./metadata.ts";
export * from "./runtime.ts";
export * from "./events.ts";
export * from "./builtins.ts";
export * from "./orchestrator/index.ts";
