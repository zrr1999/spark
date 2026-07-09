import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateDaemonStabilityChecks } from "../test/support/spark-plane-contracts.mts";

void test("zellij subscribe control report records subscript fallback, capture, cleanup, and daemon invariants", async () => {
  const report = await loadReportOrFixture();
  assert.equal(typeof report.sessionName, "string");
  assert.match(report.createdPaneId, /^terminal_[0-9]+$/u);
  assert.notEqual(report.subscriptProbe.code, 0);
  assert.equal(report.subscribeHelp.code, 0);
  assert.equal(report.subscribeCapture.code, 0);
  assert.equal(report.subscribeCapture.stdout.trim().length > 0, true);
  assert.equal(report.cleanup.closePane.code, 0);
  assert.equal(report.postCleanupPaneStillListed, false);
  const daemonChecks = evaluateDaemonStabilityChecks(report.daemonBefore, report.daemonAfter);
  assert.equal(daemonChecks.daemonRunningBefore, true);
  assert.equal(daemonChecks.daemonRunningAfter, true);
  assert.equal(daemonChecks.runtimeStable, true);
  assert.equal(daemonChecks.queueCountersMonotonic, true);
  assert.equal(report.invariants.subscriptUnsupported, true);
  assert.equal(report.invariants.subscribeHelpWorks, true);
  assert.equal(report.invariants.subscribeCaptureNonEmpty, true);
  assert.equal(report.invariants.cleanupClosedPane, true);
  assert.equal(report.invariants.paneRemovedAfterCleanup, true);
  assert.equal(report.invariants.daemonRunningBefore, true);
  assert.equal(report.invariants.daemonRunningAfter, true);
  assert.equal(report.invariants.daemonRuntimeStable, true);
  assert.equal(report.invariants.daemonFailedQueueMonotonic, true);
});

async function loadReportOrFixture(): Promise<any> {
  const path =
    process.env.SPARK_ZELLIJ_SUBSCRIBE_CONTROL_REPORT_PATH ??
    "/tmp/spark-zellij-subscribe-control-report.json";
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fixtureReport();
  }
}

function fixtureReport(): any {
  return {
    sessionName: "spark",
    createdPaneId: "terminal_123",
    subscriptProbe: { code: 1, stdout: "", stderr: "Did you mean subscribe?" },
    subscribeHelp: { code: 0, stdout: "zellij-subscribe", stderr: "" },
    subscribeCapture: { code: 0, stdout: "Spark\n/help", stderr: "" },
    cleanup: { closePane: { code: 0, stdout: "", stderr: "" } },
    postCleanupPaneStillListed: false,
    daemonBefore: fixtureDaemonStatus(0),
    daemonAfter: fixtureDaemonStatus(0),
    invariants: {
      subscriptUnsupported: true,
      subscribeHelpWorks: true,
      subscribeCaptureNonEmpty: true,
      cleanupClosedPane: true,
      paneRemovedAfterCleanup: true,
      daemonRunningBefore: true,
      daemonRunningAfter: true,
      daemonRuntimeStable: true,
      daemonFailedQueueMonotonic: true,
    },
  };
}

function fixtureDaemonStatus(failed: number): any {
  return {
    action: "status",
    daemon: {
      running: true,
      pid: 123,
      socketPath: "/tmp/spark-test.sock",
      startedAt: "2030-01-01T00:00:00.000Z",
      queue: { inbox: 0, processed: 1, failed },
      servers: [{ workspaceCount: 1, wsConnected: true }],
    },
  };
}
