import { join } from "node:path";
import {
  listSavedWorkflows,
  normalizeWorkflowId,
  userWorkflowDir as piWorkflowUserWorkflowDir,
  type WorkflowDescriptor,
  type WorkflowRegistryError,
  type WorkflowRegistryOptions,
  type WorkflowSource,
} from "@zendev-lab/pi-workflows";

export type SparkWorkflowSource = WorkflowSource;
export type SparkWorkflowRef = `workflow:${SparkWorkflowSource}-${string}`;
export interface SparkWorkflowDescriptor {
  ref: SparkWorkflowRef;
  id: string;
  source: SparkWorkflowSource;
  title: string;
  description: string;
  path: string;
  stages: string[];
  /** @deprecated Use stages. */
  phases: string[];
  mode?: WorkflowDescriptor["mode"];
}

export type SparkWorkflowRegistryError = WorkflowRegistryError;

export interface SparkWorkflowRegistryListing {
  workflows: SparkWorkflowDescriptor[];
  errors: SparkWorkflowRegistryError[];
}

export type SparkWorkflowRegistryOptions = WorkflowRegistryOptions;

export function sparkWorkflowRef(source: SparkWorkflowSource, id: string): SparkWorkflowRef {
  return `workflow:${source}-${normalizeSparkWorkflowId(id)}`;
}

export function normalizeSparkWorkflowId(id: string): string {
  return normalizeWorkflowId(id);
}

export async function listSparkWorkflowRegistry(
  cwd: string,
  options: SparkWorkflowRegistryOptions = {},
): Promise<SparkWorkflowRegistryListing> {
  const listing = await listSavedWorkflows(cwd, {
    ...options,
    workspaceWorkflowDir: options.workspaceWorkflowDir ?? workspaceWorkflowDir(cwd),
  });
  return {
    workflows: listing.workflows.map(toSparkWorkflowDescriptor),
    errors: listing.errors,
  };
}

export function workspaceWorkflowDir(cwd: string): string {
  return join(cwd, ".spark", "workflows");
}

export function userWorkflowDir(): string {
  return piWorkflowUserWorkflowDir();
}

function toSparkWorkflowDescriptor(workflow: WorkflowDescriptor): SparkWorkflowDescriptor {
  return {
    ref: sparkWorkflowRef(workflow.source, workflow.id),
    id: workflow.id,
    source: workflow.source,
    title: workflow.title,
    description: workflow.description,
    path: workflow.path,
    stages: workflow.stages,
    phases: workflow.stages,
    mode: workflow.mode,
  };
}
