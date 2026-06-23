import type { RunRef } from "@zendev-lab/pi-extension-api";
import type { SparkDynamicWorkflowEventRunView } from "./spark-dynamic-workflow-event-store.ts";
import type { SparkDynamicWorkflowRunRecord } from "./spark-dynamic-workflow-run-store.ts";

const DYNAMIC_WORKFLOW_INLINE_REF_LIMIT = 6;
const DYNAMIC_WORKFLOW_PHASE_DETAIL_LIMIT = 10;
const DYNAMIC_WORKFLOW_PHASE_SUMMARY_LIMIT = 5;

function formatInlineRefs(refs: readonly string[]): string {
  if (refs.length === 0) return "none";
  const visible = refs.slice(0, DYNAMIC_WORKFLOW_INLINE_REF_LIMIT);
  const suffix = refs.length > visible.length ? `, … ${refs.length - visible.length} more` : "";
  return `${visible.join(",")}${suffix}`;
}

export interface SparkDynamicWorkflowRunControlResult {
  action: "pause" | "resume" | "stop" | "restart" | "ack" | "save";
  run?: SparkDynamicWorkflowRunRecord;
  missing?: RunRef;
  acknowledgedRunRefs?: RunRef[];
  savedWorkflow?: { selector: string; path: string };
}

export type SparkDynamicWorkflowProjectionStatus =
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "stale"
  | "stopped";

export interface SparkDynamicWorkflowRunProjection {
  ref: RunRef;
  status: SparkDynamicWorkflowProjectionStatus;
  name: string;
  sourceLabel: string;
  updatedAt: string;
  acknowledgedAt?: string;
  completedNodes: number;
  totalNodes: number;
  active: boolean;
}

export function projectSparkDynamicWorkflowRun(
  view: SparkDynamicWorkflowEventRunView,
): SparkDynamicWorkflowRunProjection {
  const nodes = view.snapshot.nodes;
  const completedNodes = nodes.filter((node) =>
    isTerminalWorkflowProjectionStatus(node.status),
  ).length;
  return {
    ref: view.metadata.runRef,
    status: normalizeWorkflowProjectionStatus(view.snapshot.status),
    name: view.snapshot.meta?.name ?? view.metadata.meta.name,
    sourceLabel: view.metadata.source.label,
    updatedAt: view.snapshot.updatedAt ?? view.metadata.updatedAt,
    acknowledgedAt: view.metadata.acknowledgedAt,
    completedNodes,
    totalNodes: nodes.length,
    active: view.snapshot.status === "running" || view.snapshot.status === "paused",
  };
}

export function projectSparkDynamicWorkflowRuns(input: {
  runs: SparkDynamicWorkflowEventRunView[];
  includeHistory: boolean;
  targetRunRef?: RunRef;
}): SparkDynamicWorkflowRunProjection[] {
  const projected = input.runs
    .map(projectSparkDynamicWorkflowRun)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (input.targetRunRef) return projected.filter((run) => run.ref === input.targetRunRef);
  if (input.includeHistory) return projected.slice(0, 10);
  return projected
    .filter(
      (run) =>
        !run.acknowledgedAt &&
        (run.status === "running" ||
          run.status === "paused" ||
          run.status === "stale" ||
          run.status === "failed" ||
          run.status === "stopped" ||
          run.status === "succeeded"),
    )
    .slice(0, 10);
}

function normalizeWorkflowProjectionStatus(status: string): SparkDynamicWorkflowProjectionStatus {
  if (status === "queued") return "running";
  if (status === "cached" || status === "skipped") return "succeeded";
  if (
    status === "running" ||
    status === "paused" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "stale" ||
    status === "stopped"
  )
    return status;
  return "failed";
}

function isTerminalWorkflowProjectionStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "stopped" ||
    status === "stale" ||
    status === "cached" ||
    status === "skipped"
  );
}

export interface SparkDynamicWorkflowDashboardView {
  action: string;
  counts: Record<SparkDynamicWorkflowProjectionStatus, number>;
  runs: SparkDynamicWorkflowDashboardRun[];
  selectedRun?: SparkDynamicWorkflowDashboardRun;
  control?: SparkDynamicWorkflowRunControlResult;
}

export interface SparkDynamicWorkflowDashboardRun extends SparkDynamicWorkflowRunProjection {
  controls: SparkDynamicWorkflowNavigatorAction[];
  tree: SparkDynamicWorkflowDashboardNode[];
  eventTail: SparkDynamicWorkflowDashboardEvent[];
  resultPreview?: string;
  errorMessage?: string;
  savedWorkflow?: string;
}

export type SparkDynamicWorkflowNavigatorAction =
  | "inspect"
  | "pause"
  | "resume"
  | "stop"
  | "restart"
  | "save"
  | "ack";

export interface SparkDynamicWorkflowDashboardNode {
  id: string;
  kind: string;
  label: string;
  status: string;
  depth: number;
  detail?: string;
}

export interface SparkDynamicWorkflowDashboardEvent {
  sequence: number;
  type: string;
  label: string;
  status?: string;
}

export function buildSparkDynamicWorkflowDashboardView(input: {
  action: string;
  runs: SparkDynamicWorkflowEventRunView[];
  includeHistory: boolean;
  detailed: boolean;
  targetRunRef?: RunRef;
  control?: SparkDynamicWorkflowRunControlResult;
}): SparkDynamicWorkflowDashboardView {
  const selectedViews = selectSparkDynamicWorkflowRunViews(input);
  const dashboardRuns = selectedViews.map(projectSparkDynamicWorkflowDashboardRun);
  const selectedRun = input.targetRunRef
    ? dashboardRuns.find((run) => run.ref === input.targetRunRef)
    : (dashboardRuns.find((run) => run.active) ?? dashboardRuns[0]);
  return {
    action: input.action,
    counts: countProjectionStatuses(dashboardRuns),
    runs: dashboardRuns.map((run) =>
      input.detailed || run.ref === selectedRun?.ref ? run : { ...run, tree: [], eventTail: [] },
    ),
    selectedRun,
    control: input.control,
  };
}

export function renderSparkDynamicWorkflowDashboardText(
  view: SparkDynamicWorkflowDashboardView,
): string {
  const lines = [`Spark dynamic workflow dashboard (${view.action})`];
  if (view.control) appendDashboardControlLines(lines, view.control);
  lines.push(
    `Runs: total=${view.runs.length} running=${view.counts.running} paused=${view.counts.paused} failed=${view.counts.failed} stale=${view.counts.stale} stopped=${view.counts.stopped} succeeded=${view.counts.succeeded}`,
  );
  if (view.runs.length === 0) {
    lines.push("  No dynamic workflow runs match this dashboard view.");
    return lines.join("\n");
  }
  for (const run of view.runs) {
    const marker = run.ref === view.selectedRun?.ref ? "▸" : " ";
    const saved = run.savedWorkflow ? ` saved=${run.savedWorkflow}` : "";
    const acknowledged = run.acknowledgedAt ? " acknowledged" : "";
    lines.push(
      `  ${marker} ${run.ref} [${run.status}] ${run.name} · ${run.sourceLabel} · nodes=${run.completedNodes}/${run.totalNodes} · controls=${run.controls.join("/")}${saved}${acknowledged}`,
    );
  }
  if (view.selectedRun) appendDashboardSelectedRunLines(lines, view.selectedRun);
  return lines.join("\n");
}

function appendDashboardControlLines(
  lines: string[],
  control: SparkDynamicWorkflowRunControlResult,
): void {
  if (control.savedWorkflow) {
    lines.push(
      `Control: save ${control.run?.ref ?? control.missing ?? "run"} -> ${control.savedWorkflow.selector}`,
    );
  } else if (control.acknowledgedRunRefs) {
    lines.push(`Control: ack ${formatInlineRefs(control.acknowledgedRunRefs)}`);
  } else if (control.run) {
    lines.push(`Control: ${control.action} ${control.run.ref} -> ${control.run.status}`);
  } else {
    lines.push(`Control: ${control.action} missing ${control.missing ?? "run"}`);
  }
}

function appendDashboardSelectedRunLines(
  lines: string[],
  run: SparkDynamicWorkflowDashboardRun,
): void {
  lines.push(`Selected: ${run.ref} ${run.name}`);
  if (run.tree.length > 0) {
    lines.push("  Tree:");
    for (const node of run.tree.slice(0, DYNAMIC_WORKFLOW_PHASE_DETAIL_LIMIT + 4)) {
      const indent = "  ".repeat(Math.min(node.depth, 5));
      const detail = node.detail ? ` · ${node.detail}` : "";
      lines.push(
        `    ${indent}${dashboardStatusIcon(node.status)} ${node.kind} ${node.label} [${node.status}]${detail}`,
      );
    }
    if (run.tree.length > DYNAMIC_WORKFLOW_PHASE_DETAIL_LIMIT + 4)
      lines.push(
        `    … ${run.tree.length - (DYNAMIC_WORKFLOW_PHASE_DETAIL_LIMIT + 4)} more node(s)`,
      );
  }
  if (run.eventTail.length > 0) {
    lines.push("  Event tail:");
    for (const event of run.eventTail) {
      const status = event.status ? ` [${event.status}]` : "";
      lines.push(`    #${event.sequence} ${event.type}${status} ${event.label}`);
    }
  }
  if (run.resultPreview) lines.push(`  Result: ${run.resultPreview}`);
  if (run.errorMessage) lines.push(`  Error: ${compact(run.errorMessage, 180)}`);
  lines.push(`  Actions: ${run.controls.join(", ")}`);
}

function projectSparkDynamicWorkflowDashboardRun(
  view: SparkDynamicWorkflowEventRunView,
): SparkDynamicWorkflowDashboardRun {
  const projection = projectSparkDynamicWorkflowRun(view);
  return {
    ...projection,
    controls: dynamicWorkflowDashboardActions(projection.status),
    tree: view.snapshot.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      status: node.status,
      depth: workflowNodeDepth(view, node.id),
      detail: dashboardNodeDetail(node),
    })),
    eventTail: view.snapshot.eventTail.slice(-6).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      label:
        event.title ?? event.label ?? event.toolName ?? event.workflowName ?? event.nodeId ?? "run",
      status: event.status,
    })),
    resultPreview:
      view.snapshot.result === undefined
        ? undefined
        : compact(formatUnknown(view.snapshot.result), 180),
    errorMessage: view.snapshot.errorMessage,
    savedWorkflow: view.metadata.savedWorkflow?.selector,
  };
}

function selectSparkDynamicWorkflowRunViews(input: {
  runs: SparkDynamicWorkflowEventRunView[];
  includeHistory: boolean;
  targetRunRef?: RunRef;
}): SparkDynamicWorkflowEventRunView[] {
  const projected = new Map(
    input.runs.map((run) => [run.metadata.runRef, projectSparkDynamicWorkflowRun(run)]),
  );
  const sorted = [...input.runs].sort((a, b) =>
    (b.snapshot.updatedAt ?? b.metadata.updatedAt).localeCompare(
      a.snapshot.updatedAt ?? a.metadata.updatedAt,
    ),
  );
  if (input.targetRunRef) return sorted.filter((run) => run.metadata.runRef === input.targetRunRef);
  if (input.includeHistory) return sorted.slice(0, 10);
  return sorted
    .filter((run) => {
      const projection = projected.get(run.metadata.runRef);
      return (
        projection &&
        !projection.acknowledgedAt &&
        (projection.status === "running" ||
          projection.status === "paused" ||
          projection.status === "stale" ||
          projection.status === "failed" ||
          projection.status === "stopped" ||
          projection.status === "succeeded")
      );
    })
    .slice(0, 10);
}

function workflowNodeDepth(view: SparkDynamicWorkflowEventRunView, nodeId: string): number {
  let depth = 0;
  let current = view.snapshot.nodesById[nodeId];
  const seen = new Set<string>();
  while (current?.parentId && current.parentId !== current.id && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    depth += 1;
    current = view.snapshot.nodesById[current.parentId];
  }
  return Math.max(0, depth - 1);
}

function dashboardNodeDetail(
  node: SparkDynamicWorkflowEventRunView["snapshot"]["nodes"][number],
): string | undefined {
  if (node.phase && node.phase !== node.label) return `phase=${node.phase}`;
  if (node.errorMessage) return compact(node.errorMessage, 80);
  if (node.result !== undefined) return `result=${compact(formatUnknown(node.result), 80)}`;
  return undefined;
}

function dynamicWorkflowDashboardActions(
  status: SparkDynamicWorkflowProjectionStatus,
): SparkDynamicWorkflowNavigatorAction[] {
  if (status === "running") return ["inspect", "pause", "stop", "save"];
  if (status === "paused") return ["inspect", "resume", "stop", "restart", "save"];
  if (status === "stale") return ["inspect", "resume", "stop", "restart", "save", "ack"];
  if (status === "succeeded") return ["inspect", "save", "ack"];
  return ["inspect", "restart", "save", "ack"];
}

function countProjectionStatuses(
  runs: SparkDynamicWorkflowRunProjection[],
): Record<SparkDynamicWorkflowProjectionStatus, number> {
  return {
    running: runs.filter((run) => run.status === "running").length,
    paused: runs.filter((run) => run.status === "paused").length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    failed: runs.filter((run) => run.status === "failed").length,
    stale: runs.filter((run) => run.status === "stale").length,
    stopped: runs.filter((run) => run.status === "stopped").length,
  };
}

function dashboardStatusIcon(status: string): string {
  if (status === "succeeded" || status === "cached") return "✓";
  if (status === "failed") return "✗";
  if (status === "paused") return "Ⅱ";
  if (status === "stopped") return "■";
  if (status === "stale") return "!";
  if (status === "skipped") return "↷";
  return "…";
}

export function selectSparkDynamicWorkflowRuns(input: {
  runs: SparkDynamicWorkflowRunRecord[];
  includeHistory: boolean;
  targetRunRef?: RunRef;
}): SparkDynamicWorkflowRunRecord[] {
  const sorted = [...input.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (input.targetRunRef) return sorted.filter((run) => run.ref === input.targetRunRef);
  if (input.includeHistory) return sorted.slice(0, 10);
  return sorted
    .filter(
      (run) =>
        !run.acknowledgedAt &&
        (run.status === "running" ||
          run.status === "paused" ||
          run.status === "stale" ||
          run.status === "failed"),
    )
    .slice(0, 10);
}

export function renderSparkDynamicWorkflowRunsText(input: {
  action: string;
  runs: SparkDynamicWorkflowRunRecord[];
  detailed: boolean;
  control?: SparkDynamicWorkflowRunControlResult;
}): string {
  const lines: string[] = [];
  if (input.control) {
    if (input.control.savedWorkflow) {
      lines.push(
        `Dynamic workflow save: ${input.control.run?.ref ?? input.control.missing ?? "run"} -> ${input.control.savedWorkflow.selector}`,
      );
      lines.push(`  Saved script: ${input.control.savedWorkflow.path}`);
    } else if (input.control.acknowledgedRunRefs) {
      lines.push(
        `Dynamic workflow ack: acknowledged=${input.control.acknowledgedRunRefs.length}${input.control.acknowledgedRunRefs.length ? ` refs=${formatInlineRefs(input.control.acknowledgedRunRefs)}` : ""}`,
      );
    } else if (input.control.run) {
      lines.push(
        `Dynamic workflow ${input.control.action}: ${input.control.run.ref} -> ${input.control.run.status}`,
      );
      if (input.control.action === "restart")
        lines.push(
          `  Next: call workflow_run({ runRef: "${input.control.run.ref}" }) to execute the restarted script.`,
        );
    } else {
      lines.push(
        `Dynamic workflow ${input.control.action}: missing ${input.control.missing ?? "run"}`,
      );
    }
  }
  const running = input.runs.filter((run) => run.status === "running").length;
  const paused = input.runs.filter((run) => run.status === "paused").length;
  const failed = input.runs.filter((run) => run.status === "failed").length;
  const stale = input.runs.filter((run) => run.status === "stale").length;
  const stopped = input.runs.filter((run) => run.status === "stopped").length;
  const succeeded = input.runs.filter((run) => run.status === "succeeded").length;
  const acknowledged = input.runs.filter((run) => run.acknowledgedAt).length;
  lines.push(
    `Dynamic workflow runs: runs=${input.runs.length} running=${running} paused=${paused} failed=${failed} stale=${stale} stopped=${stopped} succeeded=${succeeded} acknowledged=${acknowledged}`,
  );
  if (input.runs.length === 0) {
    lines.push("  No dynamic workflow runs match this view.");
    return lines.join("\n");
  }
  for (const run of input.runs) {
    lines.push(`  - ${formatSparkDynamicWorkflowRunLine(run)}`);
    if (input.detailed) appendSparkDynamicWorkflowRunDetails(lines, run, "    ");
  }
  return lines.join("\n");
}

export function formatSparkDynamicWorkflowRunLine(run: SparkDynamicWorkflowRunRecord): string {
  const phaseSummary = formatPhaseSummary(run);
  const base = run.base?.baseRef ? ` base=${run.base.baseRef}` : "";
  const tokens = formatWorkflowUsageInline(run);
  const agents = ` agents=${run.agentCount || run.journal.length}`;
  const acknowledged = run.acknowledgedAt ? ` acknowledged=${run.acknowledgedAt}` : "";
  const saved = run.savedWorkflow ? ` saved=${run.savedWorkflow.selector}` : "";
  const approval = run.approval
    ? ` approval=${run.approval.method}:${run.approval.summary.riskFlags.join("+")}`
    : "";
  const error = run.errorMessage ? ` error=${compact(run.errorMessage, 80)}` : "";
  return `${run.ref} [${run.status}] ${run.source.label} phases=${phaseSummary}${agents}${tokens}${base}${saved}${approval}${acknowledged} updated=${run.updatedAt}${error}`;
}

function appendSparkDynamicWorkflowRunDetails(
  lines: string[],
  run: SparkDynamicWorkflowRunRecord,
  indent: string,
): void {
  lines.push(
    `${indent}Script: ${run.scriptHash.slice(0, 12)} source=${run.source.kind}${run.source.selector ? ` selector=${run.source.selector}` : ""}`,
  );
  if (run.base)
    lines.push(
      `${indent}Base: ref=${run.base.baseRef ?? "unknown"} state=${run.base.baseState ?? "unknown"} tree=${run.base.baseTree ?? "unknown"}`,
    );
  if (run.approval)
    lines.push(
      `${indent}Approval: method=${run.approval.method} approvedAt=${run.approval.approvedAt} risks=${formatInlineRefs(run.approval.summary.riskFlags)}`,
    );
  const usage = formatWorkflowUsageDetails(run);
  if (usage) lines.push(`${indent}Usage: ${usage}`);
  lines.push(`${indent}Timeline: ${formatPhaseTimeline(run)}`);
  lines.push(`${indent}Controls: ${formatDynamicWorkflowControls(run)}`);
  if ((run.agentTelemetry ?? []).length > 0) {
    const tail = (run.agentTelemetry ?? []).slice(-5);
    lines.push(
      `${indent}Agent telemetry tail (${tail.length}/${run.agentTelemetry?.length ?? 0}):`,
    );
    for (const item of tail) lines.push(`${indent}  - ${formatAgentTelemetry(item)}`);
  }
  if (run.phases.length > 0) {
    const phases = run.phases.slice(0, DYNAMIC_WORKFLOW_PHASE_DETAIL_LIMIT);
    lines.push(`${indent}Phases (${phases.length}/${run.phases.length}):`);
    for (const phase of phases) {
      lines.push(`${indent}  - ${phase.title}: ${phase.status ?? "running"}`);
    }
    if (run.phases.length > phases.length)
      lines.push(`${indent}  - … ${run.phases.length - phases.length} more phase(s)`);
  }
  if (run.journal.length > 0) {
    const tail = run.journal.slice(-5);
    lines.push(`${indent}Agent journal tail (${tail.length}/${run.journal.length}):`);
    for (const entry of tail)
      lines.push(
        `${indent}  - #${entry.index} hash=${entry.hash.slice(0, 12)}${formatJournalResult(entry.result)}`,
      );
  }
  if (run.result !== undefined)
    lines.push(`${indent}Result: ${compact(formatUnknown(run.result), 240)}`);
  if (run.savedWorkflow)
    lines.push(
      `${indent}Saved workflow: ${run.savedWorkflow.selector} (${run.savedWorkflow.path})`,
    );
  if (run.acknowledgedAt) lines.push(`${indent}Acknowledged: ${run.acknowledgedAt}`);
  if (run.errorMessage) lines.push(`${indent}Error: ${run.errorMessage}`);
  lines.push(`${indent}Next: ${dynamicWorkflowNextAction(run)}.`);
}

function formatWorkflowUsageInline(run: SparkDynamicWorkflowRunRecord): string {
  const totals = run.usageTotals;
  if (totals) {
    const degraded = totals.estimatedTokens > 0 ? ` estimated=${totals.estimatedTokens}` : "";
    const cost = totals.costUsd !== undefined ? ` cost=$${totals.costUsd.toFixed(4)}` : "";
    return ` tokens=${totals.totalTokens}${degraded}${cost}`;
  }
  return run.spentTokens !== undefined ? ` tokens=${run.spentTokens}` : "";
}

function formatWorkflowUsageDetails(run: SparkDynamicWorkflowRunRecord): string | undefined {
  const totals = run.usageTotals;
  if (!totals) return run.spentTokens !== undefined ? `${run.spentTokens} tokens` : undefined;
  const parts = [`${totals.totalTokens} tokens`];
  if (totals.actualTokens > 0) parts.push(`actual=${totals.actualTokens}`);
  if (totals.estimatedTokens > 0) parts.push(`estimated=${totals.estimatedTokens}`);
  if (totals.inputTokens !== undefined) parts.push(`input=${totals.inputTokens}`);
  if (totals.outputTokens !== undefined) parts.push(`output=${totals.outputTokens}`);
  if (totals.cacheReadTokens !== undefined) parts.push(`cacheRead=${totals.cacheReadTokens}`);
  if (totals.cacheWriteTokens !== undefined) parts.push(`cacheWrite=${totals.cacheWriteTokens}`);
  if (totals.costUsd !== undefined) parts.push(`cost=$${totals.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}

function formatAgentTelemetry(
  item: NonNullable<SparkDynamicWorkflowRunRecord["agentTelemetry"]>[number],
): string {
  const parts = [`#${item.index}`, item.label, item.status];
  if (item.phase) parts.push(`phase=${item.phase}`);
  if (item.usage) {
    parts.push(`tokens=${item.usage.totalTokens}`);
    parts.push(`source=${item.usage.source}`);
    if (item.usage.costUsd !== undefined) parts.push(`cost=$${item.usage.costUsd.toFixed(4)}`);
    if (item.usage.model) parts.push(`model=${item.usage.model}`);
  }
  if (item.tokensPerSecond !== undefined)
    parts.push(`rate=${item.tokensPerSecond.toFixed(2)} tok/s`);
  if (item.runRef) parts.push(`run=${item.runRef}`);
  if (item.lastActivityAt) parts.push(`last=${item.lastActivityAt}`);
  return parts.join(" ");
}

function formatPhaseSummary(run: SparkDynamicWorkflowRunRecord): string {
  if (run.phases.length === 0) return "0";
  const phases = run.phases.slice(0, DYNAMIC_WORKFLOW_PHASE_SUMMARY_LIMIT);
  const suffix = run.phases.length > phases.length ? `,+${run.phases.length - phases.length}` : "";
  return `${phases
    .map((phase) => `${phase.title}:${phase.status ?? phaseStatusFallback(run.status)}`)
    .join(",")}${suffix}`;
}

function formatPhaseTimeline(run: SparkDynamicWorkflowRunRecord): string {
  if (run.phases.length === 0) return "no phases recorded";
  const phases = run.phases.slice(0, DYNAMIC_WORKFLOW_PHASE_SUMMARY_LIMIT);
  const suffix =
    run.phases.length > phases.length ? ` → … +${run.phases.length - phases.length}` : "";
  return `${phases
    .map((phase) => `${phaseStatusIcon(phase.status, run.status)} ${phase.title}`)
    .join(" → ")}${suffix}`;
}

function phaseStatusFallback(status: SparkDynamicWorkflowRunRecord["status"]): string {
  if (status === "succeeded") return "done";
  if (status === "failed") return "interrupted";
  if (status === "stopped") return "stopped";
  if (status === "paused") return "paused";
  if (status === "stale") return "stale";
  return "running";
}

function phaseStatusIcon(
  status: SparkDynamicWorkflowRunRecord["phases"][number]["status"],
  runStatus: SparkDynamicWorkflowRunRecord["status"],
): string {
  if (status === "fail" || runStatus === "failed") return "✗";
  if (status === "skip") return "↷";
  if (runStatus === "paused") return "Ⅱ";
  if (runStatus === "stale") return "!";
  if (runStatus === "running" && status === undefined) return "…";
  return "✓";
}

function formatDynamicWorkflowControls(run: SparkDynamicWorkflowRunRecord): string {
  const inspect = `inspect runRef=${run.ref}`;
  if (run.status === "running") return `${inspect} · pause · stop`;
  if (run.status === "paused" || run.status === "stale")
    return `${inspect} · resume · stop · restart`;
  if (run.status === "failed") return `${inspect} · save · restart · ack`;
  if (run.status === "stopped") return `${inspect} · save · restart · ack`;
  if (run.status === "succeeded") return `${inspect} · save · ack`;
  return inspect;
}

function dynamicWorkflowNextAction(run: SparkDynamicWorkflowRunRecord): string {
  if (run.status === "running") return "inspect progress, pause, stop, or wait";
  if (run.status === "paused") return "resume, inspect, stop, or restart";
  if (run.status === "stale") return "inspect details, resume if safe, stop, or restart";
  if (run.status === "failed")
    return "inspect error, save script, restart after fixing the cause, or ack";
  if (run.status === "stopped")
    return "restart only if the workflow should run again, save, or ack";
  if (run.status === "succeeded")
    return "inspect result, save as reusable workflow, or ack after delivery";
  return "no action required";
}

function formatJournalResult(value: unknown): string {
  if (value === undefined) return "";
  return ` result=${compact(formatUnknown(value), 120)}`;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compact(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
