import {
  listSavedWorkflows,
  type WorkflowDescriptor,
  type WorkflowRegistryError,
} from "pi-workflows";
import { workspaceWorkflowDir } from "./spark-workflow-registry.ts";

export interface SparkSavedWorkflowDescriptor {
  name: string;
  title: string;
  description: string;
  path: string;
  phases: string[];
}

export interface SparkSavedWorkflowError {
  path: string;
  error: string;
}

export interface SparkSavedWorkflowDiscovery {
  workflows: SparkSavedWorkflowDescriptor[];
  errors: SparkSavedWorkflowError[];
}

export async function discoverSparkSavedWorkflows(
  cwd: string,
): Promise<SparkSavedWorkflowDiscovery> {
  const listing = await listSavedWorkflows(cwd, {
    includeUser: false,
    workspaceWorkflowDir: workspaceWorkflowDir(cwd),
  });
  return {
    workflows: listing.workflows.map(toSparkSavedWorkflowDescriptor),
    errors: listing.errors.map(toSparkSavedWorkflowError),
  };
}

export function renderSparkWorkflowGuidance(
  focus: string | undefined,
  saved: SparkSavedWorkflowDiscovery = { workflows: [], errors: [] },
  workflowSelector?: string,
): string {
  const budgetCatalog = renderWorkflowBudgetCatalog();
  const savedCatalog = renderSavedWorkflowCatalog(saved);
  if (workflowSelector?.startsWith("workspace:") || workflowSelector?.startsWith("user:")) {
    return (
      "Selected saved workflow: " +
      workflowSelector +
      ". Use registry metadata only for discovery; execute the workflow body only through Spark workflow runtime and role-run adapter boundaries." +
      budgetCatalog +
      savedCatalog
    );
  }
  const goalFocus = /(goal|autonomous|continue|until done|完成所有|持续|自主|继续)/i.test(
    focus?.trim() ?? "",
  );
  const recommendation =
    workflowSelector === "agent:auto"
      ? "No workflow selector was provided. Agent must choose an existing saved workflow or create a new workspace workflow before execution."
      : goalFocus
        ? "Use /goal for autonomous foreground goal progress; /workflow is for saved workflow scripts."
        : "No saved workflow was selected confidently from the focus.";
  const policy =
    workflowSelector === "agent:auto"
      ? ' Inspect available saved workflows with workflow({ action: "list" }); read likely candidates with workflow({ action: "read" }). If one existing saved workflow clearly matches the user\'s goal, use that selector and proceed through Spark workflow/runtime boundaries. If none fits and a reusable scripted workflow is needed, draft a new workspace workflow under .spark/workflows/<name>.js, then use /workflow workspace:<name> (or report that it was created and why execution should wait). Do not invent a selector, do not execute inline scripts, and ask only if choosing or creating the workflow would change user-visible scope or trust boundaries.'
      : " /workflow only accepts saved workspace:/user: workflow selectors; ask for an explicit selector before execution.";
  return recommendation + policy + budgetCatalog + savedCatalog;
}

function toSparkSavedWorkflowDescriptor(
  workflow: WorkflowDescriptor,
): SparkSavedWorkflowDescriptor {
  return {
    name: workflow.id,
    title: workflow.title,
    description: workflow.description,
    path: workflow.path,
    phases: workflow.phases,
  };
}

function toSparkSavedWorkflowError(error: WorkflowRegistryError): SparkSavedWorkflowError {
  return { path: error.path, error: error.error };
}

function renderSavedWorkflowCatalog(saved: SparkSavedWorkflowDiscovery): string {
  const lines: string[] = [];
  if (saved.workflows.length) {
    lines.push("", "Saved workflows discovered in .spark/workflows/*.js:");
    for (const item of saved.workflows) {
      lines.push(
        "- " +
          item.name +
          ": " +
          item.description +
          " (title: " +
          item.title +
          (item.phases.length ? "; phases: " + item.phases.join(", ") : "") +
          "; path: " +
          item.path +
          ")",
      );
    }
  }
  if (saved.errors.length) {
    lines.push("", "Saved workflow validation issues (not selectable until fixed):");
    for (const item of saved.errors.slice(0, 5)) {
      lines.push("- " + item.path + ": " + item.error.slice(0, 240));
    }
  }
  if (!lines.length) return "";
  lines.push(
    "Ask with ask before selecting a saved workflow unless the focus clearly names it; discovery never executes saved workflow bodies.",
  );
  return "\n" + lines.join("\n");
}

function renderWorkflowBudgetCatalog(): string {
  return [
    "",
    "Workflow budget:",
    "- Time spent in workflow: 0s",
    "- Tokens used: 0",
    "- Token budget: none",
    "- Tokens remaining: unbounded",
  ].join("\n");
}
