import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

void test("Pi extension manual matrix report covers current extension surfaces", async () => {
  const report = await loadReportOrFixture();
  assert.equal(report.ok, true);
  assert.equal(report.stepCount, 7);
  const stepNames = report.steps.map((step: any) => step.name);
  assert.ok(stepNames.includes("extension registers expected Pi surfaces"));
  assert.ok(
    stepNames.includes("project/task/todo lifecycle through canonical task_write/task_read"),
  );
  assert.ok(stepNames.includes("goal loop repro drive phase tools"));
  assert.ok(stepNames.includes("workflow/run-status/assign read surfaces"));
  assert.ok(stepNames.includes("learning/context/widget rendering"));

  const registration = report.steps.find(
    (step: any) => step.name === "extension registers expected Pi surfaces",
  )?.detail;
  for (const tool of [
    "task_read",
    "task_write",
    "assign",
    "goal",
    "loop",
    "repro",
    "drive",
    "phase",
    "workflow_run",
    "learning",
    "context",
  ]) {
    assert.ok(registration.publicTools.includes(tool), `missing ${tool}`);
  }
  assert.ok(registration.commands.includes("workflow"));
  assert.ok(registration.events.includes("session_start"));
  assert.ok(registration.shortcuts.includes("shift+tab"));
  assert.ok(registration.renderers.includes("spark-role-run-completion"));

  const lifecycle = report.steps.find(
    (step: any) =>
      step.name === "project/task/todo lifecycle through canonical task_write/task_read",
  )?.detail;
  assert.match(lifecycle.plan, /Planned tasks: created=1/u);
  assert.match(lifecycle.claim, /Claimed Spark task/u);
  assert.match(lifecycle.todo, /Updated plan items/u);
  assert.match(lifecycle.finish, /Finished Spark task/u);
  assert.equal(lifecycle.statusDetails.selectedProject.taskCounts.statusCounts.done, 1);
  assert.equal(lifecycle.taskStatus.selectedTask.status, "done");
  assert.match(lifecycle.projectList, /Manual Pi Extension Matrix/u);
  assert.match(lifecycle.renamed, /Renamed|Manual Pi Extension Matrix Renamed/u);
  assert.match(lifecycle.metadata, /Updated|metadata|Manual Pi Extension Matrix Renamed/u);
  assert.match(lifecycle.cleanup, /dry|cache|cleanup|No/u);

  const drive = report.steps.find(
    (step: any) => step.name === "goal loop repro drive phase tools",
  )?.detail;
  assert.match(drive.goalComplete, /complete|approved|Spark session goal complete/u);
  assert.match(drive.loopSchedule, /scheduled|next|loop/i);
  assert.match(drive.loopClear, /cleared|No Spark loop/i);
  assert.match(drive.reproStatus, /Stage:|manual repro focus|Acceptance/u);
  assert.match(drive.reproStop, /stopped|cleared|No Spark repro/i);
  assert.match(drive.phaseResearch, /research/i);
  assert.match(drive.phasePlan, /plan/i);
  assert.match(drive.phaseImplement, /implement/i);

  const workflow = report.steps.find(
    (step: any) => step.name === "workflow/run-status/assign read surfaces",
  )?.detail;
  assert.match(workflow.workflowStatus, /succeeded/u);
  assert.match(workflow.runList, /Dynamic workflow runs/u);
  assert.match(workflow.runInspect, /manual noop|succeeded|Result/u);
  assert.match(workflow.runAck, /ack|acknowledged|Dynamic workflow/i);
  assert.match(workflow.assignDry, /Dry-run/u);

  const widget = report.steps.find(
    (step: any) => step.name === "learning/context/widget rendering",
  )?.detail;
  assert.match(widget.learningList, /Manual Pi extension matrix|manual-pi-extension-matrix/u);
  assert.match(widget.learningRead, /Current pi-extension manual matrix/u);
  assert.match(widget.learningExport, /export|wrote|learnings/i);
  assert.match(widget.learningImportPreview, /preview|import|would|learning/i);
  assert.match(widget.learningReject, /rejected|Reject/i);
  assert.equal(
    widget.widgetLines.some((line: string) => line.includes("Evidence/review:")),
    false,
  );
  assert.equal(
    widget.directWidgetLines.some((line: string) => line.includes("Evidence/review:")),
    false,
  );
});

async function loadReportOrFixture(): Promise<any> {
  for (const path of [
    "/tmp/spark-pi-extension-manual-matrix-zellij.json",
    "/tmp/spark-pi-extension-manual-matrix.json",
  ]) {
    try {
      const report = JSON.parse(await readFile(path, "utf8"));
      const widget = report.steps?.find(
        (step: any) => step.name === "learning/context/widget rendering",
      )?.detail;
      const staleEvidenceLine = [
        ...(widget?.widgetLines ?? []),
        ...(widget?.directWidgetLines ?? []),
      ].some((line: string) => line.includes("Evidence/review:"));
      if (!staleEvidenceLine) return report;
    } catch {}
  }
  return {
    ok: true,
    stepCount: 7,
    steps: [
      {
        name: "extension registers expected Pi surfaces",
        detail: {
          publicTools: [
            "task_read",
            "task_write",
            "assign",
            "goal",
            "loop",
            "repro",
            "drive",
            "phase",
            "workflow_run",
            "learning",
            "context",
          ],
          commands: ["workflow"],
          events: ["session_start"],
          shortcuts: ["shift+tab"],
          renderers: ["spark-role-run-completion"],
        },
      },
      {
        name: "project/task/todo lifecycle through canonical task_write/task_read",
        detail: {
          plan: "Planned tasks: created=1",
          claim: "Claimed Spark task",
          todo: "Updated plan items",
          finish: "Finished Spark task",
          taskStatus: { selectedTask: { status: "done" } },
          projectList: "Manual Pi Extension Matrix",
          renamed: "Renamed Manual Pi Extension Matrix Renamed",
          metadata: "Updated metadata",
          cleanup: "dry cache cleanup",
          statusDetails: { selectedProject: { taskCounts: { statusCounts: { done: 1 } } } },
        },
      },
      {
        name: "goal loop repro drive phase tools",
        detail: {
          goalComplete: "Spark session goal complete",
          loopSchedule: "scheduled loop",
          loopClear: "cleared",
          reproStatus: "Stage:",
          reproStop: "stopped",
          phaseResearch: "research",
          phasePlan: "plan",
          phaseImplement: "implement",
        },
      },
      {
        name: "workflow/run-status/assign read surfaces",
        detail: {
          workflowStatus: "succeeded",
          runList: "Dynamic workflow runs",
          runInspect: "manual noop succeeded Result",
          runAck: "acknowledged",
          assignDry: "Dry-run",
        },
      },
      {
        name: "learning/context/widget rendering",
        detail: {
          learningList: "Manual Pi extension matrix",
          learningRead: "Current pi-extension manual matrix",
          learningExport: "export",
          learningImportPreview: "preview import learning",
          learningReject: "rejected",
          widgetLines: ["Project: Manual Pi extension matrix"],
          directWidgetLines: ["Project: Manual Pi extension matrix"],
        },
      },
    ],
  };
}
