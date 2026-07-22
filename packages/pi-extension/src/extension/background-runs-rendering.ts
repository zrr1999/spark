import type { RoleRunJsonEventsTail, RoleRunTextTail } from "@zendev-lab/spark-runtime";
import type { SparkBackgroundChildRunView, SparkBackgroundRunsDetails } from "./background-runs.ts";
import { shortRoleLabel } from "./task-ownership.ts";

const BACKGROUND_ACTIVE_CHILD_LIMIT = 5;
const BACKGROUND_CHILD_LIST_LIMIT = 10;
const BACKGROUND_DETAIL_RUN_LIMIT = 5;
const BACKGROUND_DETAIL_CHILD_LIMIT = 8;
const BACKGROUND_INLINE_REF_LIMIT = 6;

function formatInlineRefs(refs: readonly string[]): string {
  if (refs.length === 0) return "none";
  const visible = refs.slice(0, BACKGROUND_INLINE_REF_LIMIT);
  const suffix = refs.length > visible.length ? `, … ${refs.length - visible.length} more` : "";
  return `${visible.join(",")}${suffix}`;
}

function roleRunTailMetadata(tail: RoleRunTextTail): string {
  const shown = tail.truncated ? `, showing last ${tail.tailBytes} bytes` : "";
  const suffix = tail.truncated ? " (truncated)" : "";
  return `${tail.bytes} bytes${shown}${suffix}`;
}

function jsonEventsTailMetadata(tail: RoleRunJsonEventsTail): string {
  const shown = tail.truncated ? `, showing last ${tail.tailEventCount}` : "";
  const suffix = tail.truncated ? " (truncated)" : "";
  return `${tail.count} event(s)${shown}${suffix}`;
}

function roleRunControlLabel(child: SparkBackgroundChildRunView): string | undefined {
  if (!child.activeProcess) return undefined;
  return child.inputControl && child.inputControl !== "none" ? "kill/reply/steer" : "kill";
}

function roleRunControlDetail(child: SparkBackgroundChildRunView): string | undefined {
  if (!child.activeProcess) return undefined;
  if (child.inputControl && child.inputControl !== "none") return "kill/reply/steer available";
  return "kill available; reply/steer unavailable (no input control channel)";
}

function appendBackgroundChildSummaryLines(
  lines: string[],
  child: SparkBackgroundChildRunView,
  indent: string,
): void {
  if (child.summary) lines.push(`${indent}Summary: ${child.summary}`);
  else if (child.errorMessage) lines.push(`${indent}Error: ${child.errorMessage}`);
  if (child.artifactRefs.length > 0)
    lines.push(
      `${indent}Evidence: ${child.artifactRefs.length} (${formatInlineRefs(child.artifactRefs)})`,
    );
  if (child.transcriptRef) lines.push(`${indent}Transcript: ${child.transcriptRef}`);
  if (child.stdoutTail)
    lines.push(`${indent}Stdout tail: ${roleRunTailMetadata(child.stdoutTail)}`);
  if (child.stderrTail)
    lines.push(`${indent}Stderr tail: ${roleRunTailMetadata(child.stderrTail)}`);
  if (child.jsonEventsTail)
    lines.push(`${indent}JSON events tail: ${jsonEventsTailMetadata(child.jsonEventsTail)}`);
  for (const evidence of child.roleRunArtifacts ?? []) {
    if (evidence.skippedReason)
      lines.push(`${indent}Evidence ${evidence.artifactRef}: ${evidence.skippedReason}`);
  }
}

function renderBackgroundChildListLine(child: SparkBackgroundChildRunView): string {
  const taskLabel = child.taskName
    ? ` task=@${child.taskName}`
    : child.taskRef
      ? ` task=${child.taskRef}`
      : "";
  const roleLabel = child.roleRef ? ` ${shortRoleLabel(child.roleRef)}` : "";
  const summary = child.summary ? ` — ${child.summary}` : "";
  return `  - ${child.runRef}: ${child.status}${roleLabel}${taskLabel}${summary}`;
}

export function renderSparkBackgroundRunsText(
  details: SparkBackgroundRunsDetails,
  options: { detailed: boolean },
): string {
  const lines: string[] = [];
  const activeRunRef = details.summary.activeRunRef;
  const problem = details.runs.find(
    (run) =>
      (run.status === "failed" || run.status === "stale" || run.status === "timed_out") &&
      !run.acknowledgedAt,
  );
  if (details.action === "kill") {
    lines.push(`Stopped background child runs: ${details.killed?.length ?? 0}`);
    for (const killed of details.killed ?? []) {
      const task = details.childRuns.find((child) => child.runRef === killed.runRef);
      const taskLabel = task?.taskName ? ` task=@${task.taskName}` : "";
      lines.push(
        `  - ${killed.runRef} ${shortRoleLabel(killed.roleRef)}${taskLabel} signal=${killed.signal} forceScheduled=${killed.forceScheduled}`,
      );
    }
    lines.push(`Next: ${details.summary.nextAction}.`);
    return lines.join("\n");
  }
  if (details.action === "ack") {
    lines.push(
      `Acknowledged background problem runs: ${details.acknowledged?.acknowledged.length ?? 0} newly, ${details.acknowledged?.alreadyAcknowledged.length ?? 0} already, ${details.acknowledged?.skipped.length ?? 0} skipped, ${details.acknowledged?.missing.length ?? 0} missing`,
    );
    lines.push(`Next: ${details.summary.nextAction}.`);
    return lines.join("\n");
  }
  if (details.action === "inspect" && details.childRuns.length === 1) {
    const child = details.childRuns[0]!;
    lines.push(`Background child run: ${child.runRef} ${child.status}`);
    if (child.taskName || child.taskTitle)
      lines.push(
        `  Task: ${child.taskName ? `@${child.taskName}` : child.taskRef} — ${child.taskTitle ?? "untitled"}`,
      );
    if (child.roleRef || child.pid)
      lines.push(
        `  Role: ${child.roleRef ? shortRoleLabel(child.roleRef) : "unknown"}${child.pid ? ` pid=${child.pid}` : ""}${child.startedAt ? ` started=${child.startedAt}` : ""}`,
      );
    if (child.workflowRunRef) lines.push(`  Workflow run: ${child.workflowRunRef}`);
    if (child.claimKind)
      lines.push(
        `  Claim: ${child.claimKind}${child.ownerSessionId ? ` owner=${child.ownerSessionId}` : ""}`,
      );
    const control = roleRunControlDetail(child);
    if (control) lines.push(`  Control: ${control}`);
    appendBackgroundChildSummaryLines(lines, child, "  ");
    lines.push(`  Next: ${child.nextAction ?? details.summary.nextAction}.`);
    return lines.join("\n");
  }
  if (details.summary.state === "running") {
    lines.push(`Background work: running${activeRunRef ? ` ${activeRunRef}` : ""}`);
    lines.push(
      `  Progress: ${details.summary.completed}/${details.summary.scheduled} tasks finished, ${details.summary.activeChildren} active child runs`,
    );
  } else if (problem?.status === "timed_out") {
    lines.push(`Background work: historical timeout record ${problem.runRef}`);
    lines.push(
      "  This is an old foreground-wait timeout record; new background runs should stay running while children are active.",
    );
    lines.push(`  Progress: ${problem.completed}/${problem.scheduled} tasks observed finished`);
  } else if (problem) {
    lines.push(`Background work: ${details.summary.state.replace("_", " ")}`);
    lines.push(
      `  Last problem: ${problem.status} ${problem.runRef}, ${problem.completed}/${problem.scheduled} tasks finished`,
    );
  } else if (details.summary.state === "stale" && activeRunRef) {
    lines.push(`Background work: stale ${activeRunRef}`);
    lines.push(
      `  Progress: ${details.summary.completed}/${details.summary.scheduled} tasks finished, no active child process is tracked`,
    );
  } else {
    lines.push("Background work: idle");
  }
  const activeChildren = details.childRuns.filter((candidate) => candidate.activeProcess);
  if (activeChildren.length > 0) {
    lines.push("  Active children:");
    for (const child of activeChildren.slice(0, BACKGROUND_ACTIVE_CHILD_LIMIT)) {
      const taskLabel = child.taskName
        ? ` task=@${child.taskName}`
        : child.taskRef
          ? ` task=${child.taskRef}`
          : "";
      const pidLabel = child.pid ? ` pid=${child.pid}` : "";
      const controlLabel = roleRunControlLabel(child);
      const control = controlLabel ? ` control=${controlLabel}` : "";
      const summaryLabel = child.summary ? ` — ${child.summary}` : "";
      lines.push(
        `  - ${child.runRef} ${child.roleRef ? shortRoleLabel(child.roleRef) : "unknown"}${taskLabel}${pidLabel}${control}${summaryLabel}`,
      );
    }
    if (activeChildren.length > BACKGROUND_ACTIVE_CHILD_LIMIT)
      lines.push(
        `  - … ${activeChildren.length - BACKGROUND_ACTIVE_CHILD_LIMIT} more active child run(s); inspect by runRef/taskRef for details`,
      );
  }
  if (details.action === "list" && details.childRuns.length > 0) {
    lines.push("  Child runs:");
    for (const child of details.childRuns.slice(0, BACKGROUND_CHILD_LIST_LIMIT))
      lines.push(renderBackgroundChildListLine(child));
    if (details.childRuns.length > BACKGROUND_CHILD_LIST_LIMIT)
      lines.push(
        `  - … ${details.childRuns.length - BACKGROUND_CHILD_LIST_LIMIT} more child run(s); inspect by runRef/taskRef for details`,
      );
  }
  if (options.detailed) {
    const detailRuns = details.runs.slice(0, BACKGROUND_DETAIL_RUN_LIMIT);
    for (const run of detailRuns) {
      lines.push(
        `  Workflow run ${run.runRef}: ${run.status} scheduled=${run.scheduled} completed=${run.completed} incomplete=${formatInlineRefs(run.incompleteTaskRefs)}`,
      );
      if (run.legacyTimedOut)
        lines.push(
          "    Historical timeout record: old foreground-wait timeout; reconcile/inspect before acking.",
        );
      for (const action of run.nextActions.slice(0, 3)) lines.push(`    Next: ${action}`);
      if (run.nextActions.length > 3)
        lines.push(`    Next: … ${run.nextActions.length - 3} more action(s)`);
    }
    if (details.runs.length > detailRuns.length)
      lines.push(`  … ${details.runs.length - detailRuns.length} more workflow run(s)`);
    const inactiveChildren = details.childRuns.filter((candidate) => !candidate.activeProcess);
    for (const child of inactiveChildren.slice(0, BACKGROUND_DETAIL_CHILD_LIMIT)) {
      lines.push(
        `  Child ${child.runRef}: ${child.status}${child.taskName ? ` task=@${child.taskName}` : ""}${child.claimKind ? ` claim=${child.claimKind}` : ""}`,
      );
      appendBackgroundChildSummaryLines(lines, child, "    ");
    }
    if (inactiveChildren.length > BACKGROUND_DETAIL_CHILD_LIMIT)
      lines.push(
        `  … ${inactiveChildren.length - BACKGROUND_DETAIL_CHILD_LIMIT} more inactive child run(s)`,
      );
  }
  lines.push(`  Next: ${details.summary.nextAction}.`);
  return lines.join("\n");
}
