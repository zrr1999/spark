import type { TaskGraph } from "@zendev-lab/pi-tasks";
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
  _graph: TaskGraph | null,
  focus?: string,
  requestedSelector?: string,
  options: { forceNavigator?: boolean } = {},
): Promise<void> {
  const interactiveSelection = await resolveInteractiveWorkflowSelection(ctx, {
    focus,
    requestedSelector,
    forceNavigator: options.forceNavigator ?? false,
  });
  if (interactiveSelection === false) return;
  focus = interactiveSelection.focus;
  requestedSelector = interactiveSelection.selector;
  const workflow = await resolveWorkflowSelector(ctx, requestedSelector);
  if (workflow === false) return;
  const workflowSelector = workflow.selector;
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  if (workflow.descriptor?.mode === "research") {
    ctx.sparkActiveLens = { mode: "research", driver: "workflow" };
    ctx.ui?.notify?.("Builtin workflow selected.", "info");
    dispatchSparkAgentInstruction(
      piApi,
      deps,
      ctx,
      renderStandaloneBuiltinWorkflowPrompt(workflowSelector, focus),
      renderBuiltinWorkflowVisibleMessage(focus, workflowSelector),
    );
    return;
  }
  ctx.ui?.notify?.("Spark workflow driver selected.", "info");
  const savedWorkflows = await discoverSparkSavedWorkflows(ctx.cwd);
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkWorkflowDriverPrompt(focus, savedWorkflows, workflowSelector),
    renderSparkWorkflowDriverVisibleMessage(focus, workflowSelector),
  );
}

async function resolveInteractiveWorkflowSelection(
  ctx: SparkToolContext,
  input: { focus?: string; requestedSelector?: string; forceNavigator: boolean },
): Promise<{ selector?: string; focus?: string } | false> {
  const focus = input.focus?.trim() ?? "";
  if (input.requestedSelector && !input.forceNavigator) {
    return { selector: input.requestedSelector, focus };
  }
  if (!input.forceNavigator && focus) return { selector: input.requestedSelector, focus };
  if (!ctx.ui?.select && !ctx.ui?.selectWithCustom) {
    return { selector: input.requestedSelector, focus };
  }

  const listing = await listSparkWorkflowRegistry(ctx.cwd);
  const options = listing.workflows.map((workflow) => workflow.source + ":" + workflow.id);
  if (options.length === 0) {
    ctx.ui?.notify?.("No workflows are available to select.", "warning");
    return false;
  }

  const selection = await promptWorkflowSelection(ctx, options);
  if (!selection) {
    ctx.ui?.notify?.("Workflow selection cancelled.", "info");
    return false;
  }
  if (selection.customFocus) return { focus: selection.customFocus };
  const selector = normalizeWorkflowSelector(selection.selector);
  if (!selector) {
    ctx.ui?.notify?.("Workflow selection was not a valid selector.", "warning");
    return false;
  }
  const selectedFocus =
    focus || ((await ctx.ui?.input?.("Workflow request/focus (optional)")) ?? "").trim();
  return { selector, focus: selectedFocus };
}

async function promptWorkflowSelection(
  ctx: SparkToolContext,
  options: string[],
): Promise<
  { selector: string; customFocus?: never } | { selector?: never; customFocus: string } | undefined
> {
  const custom = await promptWorkflowSelectionWithCustom(ctx, options);
  if (custom !== undefined) return custom;
  const selected = await ctx.ui?.select?.("Run workflow", options);
  if (!selected) return undefined;
  return { selector: selected };
}

async function promptWorkflowSelectionWithCustom(
  ctx: SparkToolContext,
  options: string[],
): Promise<
  { selector: string; customFocus?: never } | { selector?: never; customFocus: string } | undefined
> {
  const selectWithCustom = ctx.ui?.selectWithCustom;
  if (typeof selectWithCustom !== "function") return undefined;
  const result = await selectWithCustom("Run workflow", {
    options,
    customLabel: "Describe one-off workflow request",
  });
  if (!result) return undefined;
  if (typeof result === "string") return { selector: result };
  const customText = result.customText?.trim();
  if (customText) return { customFocus: customText };
  if (result.value?.trim()) return { selector: result.value.trim() };
  return undefined;
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

function renderStandaloneBuiltinWorkflowPrompt(
  workflowSelector: string | undefined,
  focus: string | undefined,
): string {
  return [
    "## Builtin workflow",
    `Selector: ${workflowSelector ?? "agent:auto"}`,
    focus?.trim() ? `Request: ${focus.trim()}` : undefined,
    "",
    "Use the selected builtin workflow directly. Do not require project, task, or Spark state unless the user request explicitly asks to use those capabilities.",
    '- If exact orchestration details are needed, inspect it with workflow({ action: "read", selector: "' +
      (workflowSelector ?? "builtin:research") +
      '" }).',
    "Return the workflow result for the user.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderBuiltinWorkflowVisibleMessage(
  focus: string | undefined,
  workflowSelector?: string,
): string {
  const parts = ["Builtin workflow selected"];
  if (workflowSelector && workflowSelector !== "agent:auto")
    parts.push(`workflow: ${workflowSelector}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}
