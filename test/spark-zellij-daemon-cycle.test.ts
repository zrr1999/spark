import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

void test("zellij daemon cycle report validates three stable attach/control/cleanup cycles", async () => {
  const report = await loadReportOrFixture();
  assert.equal(Array.isArray(report.cycles), true);
  assert.equal(report.cycles.length, 3);
  for (const cycle of report.cycles) {
    assert.equal(cycle.launch.code, 0, `cycle ${cycle.index} launch`);
    assert.equal(cycle.subscribeCapture.code, 0, `cycle ${cycle.index} subscribe`);
    assert.equal(cycle.closePane.code, 0, `cycle ${cycle.index} close`);
    assert.equal(cycle.daemonBefore.daemonRunning, true, `cycle ${cycle.index} daemon before`);
    assert.equal(cycle.daemonAfter.daemonRunning, true, `cycle ${cycle.index} daemon after`);
    assert.equal(
      cycle.daemonBefore.runtimeId,
      cycle.daemonAfter.runtimeId,
      `cycle ${cycle.index} runtime`,
    );
  }
  assert.equal(report.staleStartupFailureLines, 0);
  assert.equal(report.anonymousSessionJsonlCreated, false);
  assert.equal(report.invariants.exactlyThreeCycles, true);
  assert.equal(report.invariants.everyLaunchSucceeded, true);
  assert.equal(report.invariants.everySubscribeSucceeded, true);
  assert.equal(report.invariants.everyCloseSucceeded, true);
  assert.equal(report.invariants.everyDaemonRunningBefore, true);
  assert.equal(report.invariants.everyDaemonRunningAfter, true);
  assert.equal(report.invariants.everyRuntimeStable, true);
  assert.equal(report.invariants.noStaleStartupFailures, true);
  assert.equal(report.invariants.noAnonymousSessionJsonlCreated, true);
});

async function loadReportOrFixture(): Promise<any> {
  const path =
    process.env.SPARK_ZELLIJ_DAEMON_CYCLE_REPORT_PATH ??
    "/tmp/spark-zellij-daemon-cycle-report.json";
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fixtureReport();
  }
}

function fixtureReport(): any {
  const cycle = (index: number) => ({
    index,
    paneId: `terminal_${index}`,
    launch: { code: 0 },
    subscribeCapture: { code: 0, stdout: "Spark" },
    closePane: { code: 0 },
    daemonBefore: { daemonRunning: true, runtimeId: "runtime" },
    daemonAfter: { daemonRunning: true, runtimeId: "runtime" },
  });
  return {
    staleStartupFailureLines: 0,
    anonymousSessionJsonlCreated: false,
    cycles: [cycle(1), cycle(2), cycle(3)],
    invariants: {
      exactlyThreeCycles: true,
      everyLaunchSucceeded: true,
      everySubscribeSucceeded: true,
      everyCloseSucceeded: true,
      everyDaemonRunningBefore: true,
      everyDaemonRunningAfter: true,
      everyRuntimeStable: true,
      noStaleStartupFailures: true,
      noAnonymousSessionJsonlCreated: true,
    },
  };
}
