import {
  listSavedWorkflows,
  type WorkflowDescriptor,
  type WorkflowRegistryError,
} from "@zendev-lab/spark-workflows";
import { workspaceWorkflowDir } from "./spark-workflow-registry.ts";

export interface SparkSavedWorkflowDescriptor {
  name: string;
  title: string;
  description: string;
  path: string;
  stages: string[];
  /** @deprecated Use stages. */
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

export function renderSparkUltracodeWorkflowGuidance(
  focus: string | undefined,
  saved: SparkSavedWorkflowDiscovery = { workflows: [], errors: [] },
): string {
  return [
    "Ultracode workflow policy:",
    "- Treat the focus as a request for high-effort orchestration, not as permission to mutate projects/tasks or bypass workflow_run approval.",
    "- Prefer a matching saved workflow when one is clearly applicable; otherwise generate a one-off metadata-first script for workflow_run.",
    '- Use workflow({ action: "list" }) / workflow({ action: "read", selector }) for discovery and preview; discovery never executes saved workflow bodies.',
    focus?.trim() ? `- Requested focus: ${focus.trim()}` : undefined,
    renderWorkflowBudgetCatalog(),
    renderSavedWorkflowCatalog(saved),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
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
      ? "No workflow selector was provided. Select an existing saved workflow or prepare a new workspace workflow before execution."
      : goalFocus
        ? "Use /goal for autonomous foreground goal progress; /workflow is reserved for saved workflow scripts."
        : "The focus did not identify a specific saved workflow.";
  const policy =
    workflowSelector === "agent:auto"
      ? ' Inspect available saved workflows with workflow({ action: "list" }); read candidate workflows with workflow({ action: "read" }). When an existing saved workflow clearly satisfies the user goal, use that selector and proceed through Spark workflow/runtime boundaries. When reusable scripted orchestration is required and no saved workflow applies, create a workspace workflow definition under .agents/workflows/<name>.js, then use /workflow workspace:<name> or report why execution should wait. Do not invent a selector, do not execute inline scripts, and ask only if choosing or creating the workflow would change user-visible scope or trust boundaries.'
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
    stages: workflow.stages,
    phases: workflow.stages,
  };
}

function toSparkSavedWorkflowError(error: WorkflowRegistryError): SparkSavedWorkflowError {
  return { path: error.path, error: error.error };
}

function renderSavedWorkflowCatalog(saved: SparkSavedWorkflowDiscovery): string {
  const lines: string[] = [];
  if (saved.workflows.length) {
    lines.push("", "Saved workflows discovered in .agents/workflows/*.js:");
    for (const item of saved.workflows) {
      lines.push(
        "- " +
          item.name +
          ": " +
          item.description +
          " (title: " +
          item.title +
          (item.stages.length ? "; stages: " + item.stages.join(", ") : "") +
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
