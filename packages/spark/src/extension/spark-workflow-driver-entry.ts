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
import { renderSparkModeVisibleMessage, renderSparkResearchModePrompt } from "./mode/index.ts";
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
  const workflow = await resolveWorkflowSelector(ctx, requestedSelector);
  if (workflow === false) return;
  const workflowSelector = workflow.selector;
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  if (project) await saveCurrentProjectRef(ctx.cwd, ctx, project.ref);
  else await clearCurrentProjectRef(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  if (workflow.descriptor?.mode === "research") {
    ctx.sparkActiveLens = { mode: "research", driver: "workflow" };
    ctx.ui?.notify?.("Spark research workflow selected.", "info");
    const workflowFocus = renderBuiltinWorkflowResearchFocus(workflowSelector, focus);
    dispatchSparkAgentInstruction(
      piApi,
      deps,
      ctx,
      [
        renderSparkResearchModePrompt(graph, project?.ref, workflowFocus),
        renderBuiltinWorkflowResearchGuidance(workflowSelector),
      ].join("\n\n"),
      renderSparkModeVisibleMessage("research", project?.title, workflowFocus),
    );
    return;
  }
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
): Promise<
  | {
      selector: string | undefined;
      descriptor?: Awaited<ReturnType<typeof listSparkWorkflowRegistry>>["workflows"][number];
    }
  | false
> {
  const listing = await listSparkWorkflowRegistry(ctx.cwd);
  const normalizedRequested = normalizeWorkflowSelector(requested);
  if (
    normalizedRequested &&
    listing.workflows.some(
      (workflow) => workflow.source + ":" + workflow.id === normalizedRequested,
    )
  ) {
    const descriptor = listing.workflows.find(
      (workflow) => workflow.source + ":" + workflow.id === normalizedRequested,
    );
    return { selector: normalizedRequested, descriptor };
  }
  if (!requested) return { selector: "agent:auto" };

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
  const match = /^(builtin|workspace|user):(.+)$/u.exec(selector.trim());
  if (!match) return undefined;
  try {
    return match[1] + ":" + normalizeSparkWorkflowId(match[2]);
  } catch {
    return undefined;
  }
}

function renderBuiltinWorkflowResearchFocus(
  workflowSelector: string | undefined,
  focus: string | undefined,
): string {
  return [
    workflowSelector ? `Builtin workflow selector: ${workflowSelector}.` : undefined,
    focus?.trim() ? `User focus: ${focus.trim()}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

function renderBuiltinWorkflowResearchGuidance(workflowSelector: string | undefined): string {
  return [
    "## Builtin workflow guidance",
    `- Selected builtin workflow: ${workflowSelector ?? "unknown"}.`,
    "- Treat the builtin workflow registry mode as authoritative routing metadata; do not look for or invent workflow meta.mode frontmatter.",
    "- Run this as research semantics: produce a synthesized report, keep repository/task mutation out of panel model calls, and use Spark workflow/runtime boundaries for workflow-owned execution.",
    '- Inspect the builtin script with workflow({ action: "read", selector: "' +
      (workflowSelector ?? "builtin:fusion") +
      '" }) when the exact orchestration details are needed.',
  ].join("\n");
}
