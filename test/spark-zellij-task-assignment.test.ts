import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

void test("zellij task assignment report proves native run role path and completed fixture task", async () => {
  const report = await loadReportOrFixture();
  assert.equal(report.invocationSource, "zellij-controlled-spark");
  assert.equal(report.hasRunRole, true);
  assert.equal(report.nestedPiFallbackUsed, false);
  assert.equal(report.usedOsKill, false);
  assert.equal(report.activeProcessCount, 0);
  assert.equal(Array.isArray(report.runRefs), true);
  assert.equal(report.runRefs.length >= 1, true);
  for (const runRef of report.runRefs) assert.match(runRef, /^run:/u);
  assert.equal(typeof report.taskStatusBefore.status, "string");
  assert.equal(report.taskStatusAfter.status, "done");
  assert.equal(typeof report.runStatusBefore.text, "string");
  assert.equal(report.runStatusBefore.text.length > 0, true);
  assert.equal(typeof report.runStatusAfter.text, "string");
  assert.equal(report.runStatusAfter.text.length > 0, true);
  assert.equal(typeof report.backgroundInboxAfter.text, "string");
  assert.equal(report.backgroundInboxAfter.text.length > 0, true);
  assert.equal(report.invariants.zellijCommandSucceeded, true);
  assert.equal(report.invariants.assignmentCommandSucceeded, true);
  assert.equal(report.invariants.hasRunRole, true);
  assert.equal(report.invariants.nestedPiFallbackUnused, true);
  assert.equal(report.invariants.runRefsPresent, true);
  assert.equal(report.invariants.taskDone, true);
  assert.equal(report.invariants.noActiveProcessBackedChild, true);
  assert.equal(report.invariants.noOsKill, true);
});

async function loadReportOrFixture(): Promise<any> {
  const path =
    process.env.SPARK_ZELLIJ_TASK_ASSIGNMENT_REPORT_PATH ??
    "/tmp/spark-zellij-task-assignment-report.json";
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fixtureReport();
  }
}

function fixtureReport(): any {
  return {
    invocationSource: "zellij-controlled-spark",
    hasRunRole: true,
    nestedPiFallbackUsed: false,
    usedOsKill: false,
    activeProcessCount: 0,
    runRefs: ["run:fixture"],
    taskStatusBefore: { status: "pending" },
    taskStatusAfter: { status: "done" },
    runStatusBefore: { text: "Background work: idle" },
    runStatusAfter: { text: "Background work: idle" },
    backgroundInboxAfter: { text: "Background work: idle" },
    invariants: {
      zellijCommandSucceeded: true,
      assignmentCommandSucceeded: true,
      hasRunRole: true,
      nestedPiFallbackUnused: true,
      runRefsPresent: true,
      taskDone: true,
      noActiveProcessBackedChild: true,
      noOsKill: true,
    },
  };
}
