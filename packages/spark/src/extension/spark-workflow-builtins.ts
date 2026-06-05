import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSparkWorkflowScript } from "spark-workflows";

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
  const dir = join(cwd, ".spark", "workflows");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return { workflows: [], errors: [] };
    throw error;
  }
  const workflows: SparkSavedWorkflowDescriptor[] = [];
  const errors: SparkSavedWorkflowError[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".js")).sort()) {
    const path = join(dir, entry);
    try {
      const script = await readFile(path, "utf8");
      const meta = parseSparkWorkflowScript(script).meta;
      workflows.push({
        name: entry.replace(/\.js$/u, ""),
        title: meta.name,
        description: meta.description,
        path,
        phases: meta.phases?.map((phase) => phase.title) ?? [],
      });
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { workflows, errors };
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
  const recommendation = goalFocus
    ? "Use /goal for autonomous foreground goal progress; /workflow is for saved workflow scripts."
    : "No saved workflow was selected confidently from the focus.";
  return (
    recommendation +
    " /workflow only accepts saved workspace:/user: workflow selectors; ask for an explicit selector before execution." +
    budgetCatalog +
    savedCatalog
  );
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
