import type { RunRef } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  dispatchSparkAgentInstruction,
  type SparkModeEntryDeps,
  type SparkModeMessageApi,
} from "./spark-mode-entry.ts";

import {
  renderSparkUltracodeWorkflowPrompt,
  renderSparkUltracodeWorkflowVisibleMessage,
  renderSparkWorkflowDriverPrompt,
  renderSparkWorkflowDriverVisibleMessage,
} from "./spark-mode-prompts.ts";
import { discoverSparkSavedWorkflows } from "./spark-workflow-builtins.ts";
import { listSparkWorkflowRegistry, normalizeSparkWorkflowId } from "./spark-workflow-registry.ts";
import {
  defaultSparkDynamicWorkflowRunStore,
  type SparkDynamicWorkflowRunRecord,
} from "./spark-dynamic-workflow-run-store.ts";
import {
  renderSparkDynamicWorkflowRunsText,
  selectSparkDynamicWorkflowRuns,
  type SparkDynamicWorkflowRunControlResult,
} from "./spark-dynamic-workflow-run-rendering.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

type SparkWorkflowNavigatorAction =
  | "inspect"
  | "pause"
  | "resume"
  | "stop"
  | "restart"
  | "save"
  | "ack";

type SparkWorkflowNavigatorSelection =
  | { selector?: string; focus?: string }
  | { dynamicAction: SparkWorkflowNavigatorAction; runRef: RunRef }
  | false;

export async function enterSparkUltracodeDriver(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  focus?: string,
): Promise<void> {
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  const savedWorkflows = await discoverSparkSavedWorkflows(ctx.cwd);
  ctx.ui?.notify?.("Spark ultracode workflow driver selected.", "info");
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkUltracodeWorkflowPrompt(focus, savedWorkflows),
    renderSparkUltracodeWorkflowVisibleMessage(focus),
  );
}

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
  if ("dynamicAction" in interactiveSelection) {
    await executeDynamicWorkflowNavigatorAction(ctx, deps, interactiveSelection);
    return;
  }
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
): Promise<SparkWorkflowNavigatorSelection> {
  const focus = input.focus?.trim() ?? "";
  if (input.requestedSelector && !input.forceNavigator) {
    return { selector: input.requestedSelector, focus };
  }
  if (!input.forceNavigator && focus) return { selector: input.requestedSelector, focus };
  if (!ctx.ui?.select && !ctx.ui?.selectWithCustom) {
    return { selector: input.requestedSelector, focus };
  }

  const listing = await listSparkWorkflowRegistry(ctx.cwd);
  const dynamicStore = defaultSparkDynamicWorkflowRunStore(ctx.cwd);
  await dynamicStore.reconcileStale();
  const dynamicOptions = dynamicWorkflowNavigatorOptions((await dynamicStore.load()).runs);
  const savedOptions = listing.workflows.map((workflow) => workflow.source + ":" + workflow.id);
  const options = [...dynamicOptions, ...savedOptions];
  if (options.length === 0) {
    ctx.ui?.notify?.("No workflows or dynamic workflow runs are available to select.", "warning");
    return false;
  }

  const selection = await promptWorkflowSelection(ctx, options);
  if (!selection) {
    ctx.ui?.notify?.("Workflow selection cancelled.", "info");
    return false;
  }
  if (selection.customFocus) return { focus: selection.customFocus };
  const dynamic = parseDynamicWorkflowNavigatorOption(selection.selector);
  if (dynamic) return dynamic;
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

function dynamicWorkflowNavigatorOptions(runs: SparkDynamicWorkflowRunRecord[]): string[] {
  return selectSparkDynamicWorkflowRuns({ runs, includeHistory: true }).flatMap((run) =>
    dynamicWorkflowNavigatorActions(run).map(
      (action) => `dynamic:${action}:${run.ref} ${run.status} ${run.source.label}`,
    ),
  );
}

function dynamicWorkflowNavigatorActions(
  run: SparkDynamicWorkflowRunRecord,
): SparkWorkflowNavigatorAction[] {
  if (run.status === "running") return ["inspect", "pause", "stop", "save"];
  if (run.status === "paused") return ["inspect", "resume", "stop", "restart", "save"];
  if (run.status === "stale") return ["inspect", "resume", "stop", "restart", "save", "ack"];
  return ["inspect", "restart", "save", "ack"];
}

function parseDynamicWorkflowNavigatorOption(
  value: string | undefined,
): { dynamicAction: SparkWorkflowNavigatorAction; runRef: RunRef } | undefined {
  if (!value) return undefined;
  const match = /^dynamic:(inspect|pause|resume|stop|restart|save|ack):(run:[a-zA-Z0-9-]+)/u.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return { dynamicAction: match[1] as SparkWorkflowNavigatorAction, runRef: match[2] as RunRef };
}

async function executeDynamicWorkflowNavigatorAction(
  ctx: SparkToolContext,
  deps: SparkModeEntryDeps,
  selection: { dynamicAction: SparkWorkflowNavigatorAction; runRef: RunRef },
): Promise<void> {
  const store = defaultSparkDynamicWorkflowRunStore(ctx.cwd);
  await store.reconcileStale();
  const existing = await store.get(selection.runRef);
  let control: SparkDynamicWorkflowRunControlResult | undefined;
  if (!existing) {
    ctx.ui?.notify?.(
      `Dynamic workflow ${selection.dynamicAction}: missing ${selection.runRef}`,
      "warning",
    );
    return;
  } else if (selection.dynamicAction === "pause") {
    const run = await store.pause(selection.runRef);
    control = run ? { action: "pause", run } : { action: "pause", missing: selection.runRef };
  } else if (selection.dynamicAction === "resume") {
    const run = await store.resume(selection.runRef);
    control = run ? { action: "resume", run } : { action: "resume", missing: selection.runRef };
  } else if (selection.dynamicAction === "stop") {
    const run = await store.stop(selection.runRef);
    control = run ? { action: "stop", run } : { action: "stop", missing: selection.runRef };
  } else if (selection.dynamicAction === "restart") {
    const run = await store.restart(selection.runRef);
    control = run ? { action: "restart", run } : { action: "restart", missing: selection.runRef };
  } else if (selection.dynamicAction === "save") {
    const savedWorkflow = await store.saveAsWorkspaceWorkflow({
      cwd: ctx.cwd,
      runRef: selection.runRef,
    });
    control = {
      action: "save",
      run: (await store.get(selection.runRef)) ?? existing,
      ...(savedWorkflow ? { savedWorkflow } : {}),
    };
  } else if (selection.dynamicAction === "ack") {
    const acknowledged = await store.acknowledge(selection.runRef);
    control = { action: "ack", acknowledgedRunRefs: acknowledged.runRefs };
  }
  const snapshot = await store.load();
  const runs = selectSparkDynamicWorkflowRuns({
    runs: snapshot.runs,
    includeHistory: true,
    targetRunRef: selection.runRef,
  });
  const text = renderSparkDynamicWorkflowRunsText({
    action: selection.dynamicAction,
    runs,
    includeDetails: true,
    control,
  });
  ctx.ui?.notify?.(text, selection.dynamicAction === "inspect" ? "info" : "success");
  await deps.refreshSparkWidget(ctx.cwd, ctx);
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
