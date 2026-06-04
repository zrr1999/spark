import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseSparkWorkflowScript } from "spark-workflows";

export type SparkWorkflowSource = "workspace" | "user";
export type SparkWorkflowRef = `workflow:${SparkWorkflowSource}-${string}`;
export interface SparkWorkflowDescriptor {
  ref: SparkWorkflowRef;
  id: string;
  source: SparkWorkflowSource;
  title: string;
  description: string;
  path: string;
  phases: string[];
}

export interface SparkWorkflowRegistryError {
  source: SparkWorkflowSource;
  path: string;
  error: string;
}

export interface SparkWorkflowRegistryListing {
  workflows: SparkWorkflowDescriptor[];
  errors: SparkWorkflowRegistryError[];
}

export interface SparkWorkflowRegistryOptions {
  includeUser?: boolean;
  userWorkflowDir?: string;
}

export function sparkWorkflowRef(source: SparkWorkflowSource, id: string): SparkWorkflowRef {
  return `workflow:${source}-${normalizeSparkWorkflowId(id)}`;
}

export function normalizeSparkWorkflowId(id: string): string {
  const normalized = id.trim().replaceAll("_", "-");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
    throw new Error("workflow id must be lowercase letters, digits, and hyphens");
  }
  return normalized;
}

export async function listSparkWorkflowRegistry(
  cwd: string,
  options: SparkWorkflowRegistryOptions = {},
): Promise<SparkWorkflowRegistryListing> {
  const includeUser = options.includeUser ?? true;
  const workspace = await discoverScriptWorkflowDir("workspace", workspaceWorkflowDir(cwd));
  const user = includeUser
    ? await discoverScriptWorkflowDir("user", options.userWorkflowDir ?? userWorkflowDir())
    : { workflows: [], errors: [] };
  return {
    workflows: [...workspace.workflows, ...user.workflows],
    errors: [...workspace.errors, ...user.errors],
  };
}

export function workspaceWorkflowDir(cwd: string): string {
  return join(cwd, ".spark", "workflows");
}

export function userWorkflowDir(): string {
  return join(homedir(), ".agents", "workflows");
}

async function discoverScriptWorkflowDir(
  source: SparkWorkflowSource,
  dir: string,
): Promise<SparkWorkflowRegistryListing> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { workflows: [], errors: [] };
    throw error;
  }
  const workflows: SparkWorkflowDescriptor[] = [];
  const errors: SparkWorkflowRegistryError[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".js")).sort()) {
    const path = join(dir, entry);
    const id = entry.replace(/\.js$/u, "");
    try {
      const script = await readFile(path, "utf8");
      const meta = parseSparkWorkflowScript(script).meta;
      workflows.push({
        ref: sparkWorkflowRef(source, id),
        id: normalizeSparkWorkflowId(id),
        source,
        title: meta.name,
        description: meta.description,
        path,
        phases: meta.phases?.map((phase) => phase.title) ?? [],
      });
    } catch (error) {
      errors.push({ source, path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { workflows, errors };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}
