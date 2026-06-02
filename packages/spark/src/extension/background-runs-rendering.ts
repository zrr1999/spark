import type { RoleRunJsonEventsTail, RoleRunTextTail } from "spark-runtime";
import type { SparkBackgroundChildRunView, SparkBackgroundRunsDetails } from "./background-runs.ts";
import { shortRoleLabel } from "./task-ownership.ts";

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

function appendBackgroundChildSummaryLines(
  lines: string[],
  child: SparkBackgroundChildRunView,
  indent: string,
): void {
  if (child.summary) lines.push(`${indent}Summary: ${child.summary}`);
  else if (child.errorMessage) lines.push(`${indent}Error: ${child.errorMessage}`);
  if (child.artifactRefs.length > 0)
    lines.push(`${indent}Artifacts: ${child.artifactRefs.join(",")}`);
  if (child.transcriptRef) lines.push(`${indent}Transcript: ${child.transcriptRef}`);
  if (child.stdoutTail)
    lines.push(`${indent}Stdout tail: ${roleRunTailMetadata(child.stdoutTail)}`);
  if (child.stderrTail)
    lines.push(`${indent}Stderr tail: ${roleRunTailMetadata(child.stderrTail)}`);
  if (child.jsonEventsTail)
    lines.push(`${indent}JSON events tail: ${jsonEventsTailMetadata(child.jsonEventsTail)}`);
  for (const artifact of child.roleRunArtifacts ?? []) {
    if (artifact.skippedReason)
      lines.push(`${indent}Artifact ${artifact.artifactRef}: ${artifact.skippedReason}`);
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
  options: { includeDetails: boolean },
): string {
  const lines: string[] = [];
  const activeRunRef = details.summary.activeDagRunRef;
  const problem = details.dagRuns.find(
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
    if (child.dagRunRef) lines.push(`  Workflow run: ${child.dagRunRef}`);
    if (child.claimKind)
      lines.push(
        `  Claim: ${child.claimKind}${child.ownerSessionId ? ` owner=${child.ownerSessionId}` : ""}`,
      );
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
    lines.push(`Background work: legacy timeout record ${problem.runRef}`);
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
    for (const child of activeChildren) {
      const taskLabel = child.taskName
        ? ` task=@${child.taskName}`
        : child.taskRef
          ? ` task=${child.taskRef}`
          : "";
      const pidLabel = child.pid ? ` pid=${child.pid}` : "";
      const summaryLabel = child.summary ? ` — ${child.summary}` : "";
      lines.push(
        `  - ${child.runRef} ${child.roleRef ? shortRoleLabel(child.roleRef) : "unknown"}${taskLabel}${pidLabel}${summaryLabel}`,
      );
    }
  }
  if (details.action === "list" && details.childRuns.length > 0) {
    lines.push("  Child runs:");
    for (const child of details.childRuns) lines.push(renderBackgroundChildListLine(child));
  }
  if (options.includeDetails) {
    for (const run of details.dagRuns) {
      lines.push(
        `  Workflow run ${run.runRef}: ${run.status} scheduled=${run.scheduled} completed=${run.completed} incomplete=${run.incompleteTaskRefs.join(",") || "none"}`,
      );
      if (run.legacyTimedOut)
        lines.push(
          "    Legacy timeout record: old foreground-wait timeout; reconcile/inspect before acking.",
        );
      for (const action of run.nextActions) lines.push(`    Next: ${action}`);
    }
    for (const child of details.childRuns.filter((candidate) => !candidate.activeProcess)) {
      lines.push(
        `  Child ${child.runRef}: ${child.status}${child.taskName ? ` task=@${child.taskName}` : ""}${child.claimKind ? ` claim=${child.claimKind}` : ""}`,
      );
      appendBackgroundChildSummaryLines(lines, child, "    ");
    }
  }
  lines.push(`  Next: ${details.summary.nextAction}.`);
  return lines.join("\n");
}
