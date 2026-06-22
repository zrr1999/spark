import type { RunRef } from "@zendev-lab/pi-extension-api";
import type { SparkDynamicWorkflowRunRecord } from "./spark-dynamic-workflow-run-store.ts";

export interface SparkDynamicWorkflowRunControlResult {
  action: "pause" | "resume" | "stop" | "restart" | "ack" | "save";
  run?: SparkDynamicWorkflowRunRecord;
  missing?: RunRef;
  acknowledgedRunRefs?: RunRef[];
  savedWorkflow?: { selector: string; path: string };
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
  includeDetails: boolean;
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
        `Dynamic workflow ack: acknowledged=${input.control.acknowledgedRunRefs.length}${input.control.acknowledgedRunRefs.length ? ` refs=${input.control.acknowledgedRunRefs.join(",")}` : ""}`,
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
    if (input.includeDetails) appendSparkDynamicWorkflowRunDetails(lines, run, "    ");
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
      `${indent}Approval: method=${run.approval.method} approvedAt=${run.approval.approvedAt} risks=${run.approval.summary.riskFlags.join(",")}`,
    );
  const usage = formatWorkflowUsageDetails(run);
  if (usage) lines.push(`${indent}Usage: ${usage}`);
  if ((run.agentTelemetry ?? []).length > 0) {
    const tail = (run.agentTelemetry ?? []).slice(-5);
    lines.push(
      `${indent}Agent telemetry tail (${tail.length}/${run.agentTelemetry?.length ?? 0}):`,
    );
    for (const item of tail) lines.push(`${indent}  - ${formatAgentTelemetry(item)}`);
  }
  if (run.phases.length > 0) {
    lines.push(`${indent}Phases:`);
    for (const phase of run.phases) {
      lines.push(`${indent}  - ${phase.title}: ${phase.status ?? "running"}`);
    }
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
  return run.phases.map((phase) => `${phase.title}:${phase.status ?? "running"}`).join(",");
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
