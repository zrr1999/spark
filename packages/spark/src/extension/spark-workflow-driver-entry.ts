import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  clearCurrentProjectRef,
  currentSparkProject,
  saveCurrentProjectRef,
} from "./session-state.ts";
import {
  dispatchSparkAgentInstruction,
  type SparkModeEntryDeps,
  type SparkModeMessageApi,
} from "./spark-mode-entry.ts";
import {
  renderSparkWorkflowDriverPrompt,
  renderSparkWorkflowDriverVisibleMessage,
} from "./spark-mode-prompts.ts";
import { discoverSparkSavedWorkflows } from "./spark-workflow-builtins.ts";
import { listSparkWorkflowRegistry, normalizeSparkWorkflowId } from "./spark-workflow-registry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export async function enterSparkWorkflowDriver(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
  requestedSelector?: string,
): Promise<void> {
  const workflowSelector = await resolveWorkflowSelector(ctx, requestedSelector);
  if (workflowSelector === false) return;
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  if (project) await saveCurrentProjectRef(ctx.cwd, ctx, project.ref);
  else await clearCurrentProjectRef(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark workflow driver selected.", "info");
  const savedWorkflows = await discoverSparkSavedWorkflows(ctx.cwd);
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkWorkflowDriverPrompt(graph, project?.ref, focus, savedWorkflows, workflowSelector),
    renderSparkWorkflowDriverVisibleMessage(project?.title, focus, workflowSelector),
  );
}

async function resolveWorkflowSelector(
  ctx: SparkToolContext,
  requested: string | undefined,
): Promise<string | false | undefined> {
  const listing = await listSparkWorkflowRegistry(ctx.cwd);
  const normalizedRequested = normalizeWorkflowSelector(requested);
  if (
    normalizedRequested &&
    listing.workflows.some(
      (workflow) => workflow.source + ":" + workflow.id === normalizedRequested,
    )
  ) {
    return normalizedRequested;
  }
  if (!requested) return "agent:auto";

  const available = listing.workflows.map((workflow) => workflow.source + ":" + workflow.id);
  const reason = normalizedRequested
    ? "Spark workflow selector not found: " + normalizedRequested + "."
    : "Spark workflow driver needs an explicit saved workflow selector.";
  const suffix = available.length
    ? " Available workflow(s): " + available.join(", ") + "."
    : " Create a saved workspace workflow under .spark/workflows/<name>.js, then run /workflow workspace:<name>.";
  ctx.ui?.notify?.(reason + suffix, "warning");
  return false;
}

function normalizeWorkflowSelector(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const match = /^(workspace|user):(.+)$/u.exec(selector.trim());
  if (!match) return undefined;
  try {
    return match[1] + ":" + normalizeSparkWorkflowId(match[2]);
  } catch {
    return undefined;
  }
}
