import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDaemonReadiness,
  redactSecrets,
  type SparkDaemonReadinessReport,
} from "../scripts/spark-daemon-readiness.mts";

function secretValues(report: SparkDaemonReadinessReport): unknown[] {
  const values: unknown[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, field] of Object.entries(value)) {
      if (/token|secret|key/iu.test(key)) values.push(field);
      visit(field);
    }
  }
  visit(report.status);
  return values;
}

void test("daemon readiness flags failed queue and disconnected websocket state", () => {
  const report = evaluateDaemonReadiness(
    daemonStatus({
      queue: { inbox: 0, processed: 20, failed: 3 },
      servers: [
        {
          url: "http://127.0.0.1:5173/",
          workspaceCount: 2,
          wsConnected: false,
          runtimeTokenExpiresAt: "2030-01-01T00:00:00.000Z",
          refreshTokenExpiresAt: "2030-01-02T00:00:00.000Z",
        },
      ],
    }),
    daemonStatus({ queue: { inbox: 0, processed: 18, failed: 2 } }),
  );

  assert.equal(report.overall, "warn");
  assert.equal(report.checks.find((check) => check.id === "daemonRunning")?.level, "pass");
  assert.equal(report.checks.find((check) => check.id === "queue.failed")?.level, "warn");
  assert.match(
    report.checks.find((check) => check.id === "queue.failed")?.message ?? "",
    /failed counter is 3/,
  );
  assert.equal(report.checks.find((check) => check.id === "queue.delta.inbox")?.level, "pass");
  assert.equal(report.checks.find((check) => check.id === "queue.delta.processed")?.level, "pass");
  assert.equal(report.checks.find((check) => check.id === "queue.delta.failed")?.level, "warn");
  assert.match(
    report.checks.find((check) => check.id === "queue.delta.failed")?.message ?? "",
    /new daemon failures/,
  );
  assert.equal(report.checks.find((check) => check.id === "websocketState")?.level, "warn");
  assert.match(
    report.checks.find((check) => check.id === "websocketState")?.message ?? "",
    /disconnected/,
  );
  assert.deepEqual(secretValues(report), ["<redacted>", "<redacted>"]);
});

void test("daemon readiness reports missing queue deltas without baseline", () => {
  const report = evaluateDaemonReadiness(
    daemonStatus({
      queue: { inbox: 0, processed: 1, failed: 0 },
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    }),
  );

  assert.equal(report.checks.find((check) => check.id === "queue.delta.inbox")?.level, "warn");
  assert.equal(report.checks.find((check) => check.id === "queue.delta.processed")?.level, "warn");
  assert.equal(report.checks.find((check) => check.id === "queue.delta.failed")?.level, "warn");
});

void test("daemon readiness fails when daemon is not running", () => {
  const report = evaluateDaemonReadiness(
    daemonStatus({
      running: false,
      queue: { inbox: 1, processed: 0, failed: 0 },
      servers: [{ workspaceCount: 0, wsConnected: false }],
    }),
  );

  assert.equal(report.overall, "fail");
  assert.equal(report.checks.find((check) => check.id === "daemonRunning")?.level, "fail");
  assert.equal(report.checks.find((check) => check.id === "websocketState")?.level, "warn");
});

void test("daemon readiness reports malformed current daemon envelopes as contract failures", () => {
  const report = evaluateDaemonReadiness({ action: "status", daemon: { running: true } });

  assert.equal(report.overall, "fail");
  assert.equal(report.checks.find((check) => check.id === "daemonRunning")?.level, "pass");
  assert.equal(report.checks.find((check) => check.id === "contract.daemon.queue")?.level, "fail");
  assert.match(
    report.checks.find((check) => check.id === "contract.daemon.queue")?.message ?? "",
    /daemon\.queue/,
  );
});

void test("daemon readiness reports missing daemon.running with contract path", () => {
  const report = evaluateDaemonReadiness({
    action: "status",
    daemon: { queue: { inbox: 0, processed: 1, failed: 0 } },
  });

  assert.equal(report.overall, "fail");
  assert.equal(report.checks.find((check) => check.id === "daemonRunning")?.level, "fail");
  assert.match(
    report.checks.find((check) => check.id === "daemonRunning")?.message ?? "",
    /daemon\.running/,
  );
});

void test("redactSecrets recursively replaces token secret and key values", () => {
  assert.deepEqual(
    redactSecrets({
      runtimeToken: "abc",
      nested: { apiSecret: "def", safe: "ok", keyPath: "ghi" },
      list: [{ refreshTokenExpiresAt: "2030" }],
    }),
    {
      runtimeToken: "<redacted>",
      nested: { apiSecret: "<redacted>", safe: "ok", keyPath: "<redacted>" },
      list: [{ refreshTokenExpiresAt: "<redacted>" }],
    },
  );
});

function daemonStatus(overrides: {
  running?: boolean;
  queue: { inbox: number; processed: number; failed: number };
  servers?: Array<Record<string, unknown>>;
}): unknown {
  return {
    action: "status",
    daemon: {
      running: overrides.running ?? true,
      pid: 123,
      socketPath: "/tmp/spark-test.sock",
      startedAt: "2030-01-01T00:00:00.000Z",
      queue: overrides.queue,
      servers: overrides.servers ?? [],
    },
  };
}
