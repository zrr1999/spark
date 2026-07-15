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

void test("daemon readiness flags new failed invocations and disconnected websocket state", () => {
  const report = evaluateDaemonReadiness(
    daemonStatus({
      invocations: { queued: 0, running: 1, succeeded: 20, failed: 3, cancelled: 0 },
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
    daemonStatus({
      invocations: { queued: 0, running: 0, succeeded: 18, failed: 2, cancelled: 0 },
    }),
  );

  assert.equal(report.overall, "warn");
  assert.equal(report.checks.find((check) => check.id === "daemonRunning")?.level, "pass");
  assert.equal(report.checks.find((check) => check.id === "invocations.failed")?.level, "pass");
  assert.match(
    report.checks.find((check) => check.id === "invocations.failed")?.message ?? "",
    /contains 3 failed item/u,
  );
  assert.equal(
    report.checks.find((check) => check.id === "invocations.delta.queued")?.level,
    "pass",
  );
  assert.equal(
    report.checks.find((check) => check.id === "invocations.delta.failed")?.level,
    "warn",
  );
  assert.match(
    report.checks.find((check) => check.id === "invocations.delta.failed")?.message ?? "",
    /new daemon failures/,
  );
  assert.equal(report.checks.find((check) => check.id === "websocketState")?.level, "warn");
  assert.match(
    report.checks.find((check) => check.id === "websocketState")?.message ?? "",
    /disconnected/,
  );
  assert.deepEqual(secretValues(report), ["<redacted>", "<redacted>"]);
});

void test("daemon readiness reports missing invocation deltas without baseline", () => {
  const report = evaluateDaemonReadiness(
    daemonStatus({
      invocations: { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    }),
  );

  assert.equal(
    report.checks.find((check) => check.id === "invocations.delta.queued")?.level,
    "warn",
  );
  assert.equal(
    report.checks.find((check) => check.id === "invocations.delta.failed")?.level,
    "warn",
  );
});

void test("daemon readiness keeps historical failures informational when baseline is unchanged", () => {
  const current = daemonStatus({
    observedAt: "2026-07-15T12:00:00.000Z",
    invocations: { queued: 0, running: 0, succeeded: 120, failed: 11, cancelled: 2 },
    servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
  });
  const baseline = daemonStatus({
    observedAt: "2026-07-15T11:55:00.000Z",
    invocations: { queued: 0, running: 0, succeeded: 120, failed: 11, cancelled: 2 },
  });
  const report = evaluateDaemonReadiness(current, baseline);

  assert.equal(report.overall, "pass");
  assert.equal(report.checks.find((check) => check.id === "invocations.failed")?.level, "pass");
  assert.equal(report.checks.find((check) => check.id === "invocations.delta.failed")?.value, 0);
  assert.equal(
    report.checks.find((check) => check.id === "invocations.stuck.queued")?.level,
    "pass",
  );
  assert.equal(
    report.checks.find((check) => check.id === "invocations.stuck.running")?.level,
    "pass",
  );
});

void test("daemon readiness warns only after queued and running age thresholds", () => {
  const baseline = daemonStatus({
    observedAt: "2026-07-15T11:59:00.000Z",
    invocations: { queued: 1, running: 1, succeeded: 0, failed: 0, cancelled: 0 },
  });
  const fresh = evaluateDaemonReadiness(
    daemonStatus({
      observedAt: "2026-07-15T12:00:00.000Z",
      invocationHealth: {
        oldestQueuedAt: "2026-07-15T11:56:00.001Z",
        oldestRunningAt: "2026-07-15T11:46:00.001Z",
      },
      invocations: { queued: 1, running: 1, succeeded: 0, failed: 0, cancelled: 0 },
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    }),
    baseline,
  );
  assert.equal(
    fresh.checks.find((check) => check.id === "invocations.stuck.queued")?.level,
    "pass",
  );
  assert.equal(
    fresh.checks.find((check) => check.id === "invocations.stuck.running")?.level,
    "pass",
  );

  const stuck = evaluateDaemonReadiness(
    daemonStatus({
      observedAt: "2026-07-15T12:00:00.000Z",
      invocationHealth: {
        oldestQueuedAt: "2026-07-15T11:55:00.000Z",
        oldestRunningAt: "2026-07-15T11:45:00.000Z",
      },
      invocations: { queued: 1, running: 1, succeeded: 0, failed: 0, cancelled: 0 },
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    }),
    baseline,
  );
  assert.equal(
    stuck.checks.find((check) => check.id === "invocations.stuck.queued")?.level,
    "warn",
  );
  assert.equal(
    stuck.checks.find((check) => check.id === "invocations.stuck.running")?.level,
    "warn",
  );
  assert.match(
    stuck.checks.find((check) => check.id === "invocations.stuck.running")?.message ?? "",
    /invocation list --status running/u,
  );
});

void test("daemon readiness fails when daemon is not running", () => {
  const report = evaluateDaemonReadiness(
    daemonStatus({
      running: false,
      invocations: { queued: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
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
  assert.equal(
    report.checks.find((check) => check.id === "contract.daemon.invocations")?.level,
    "fail",
  );
  assert.match(
    report.checks.find((check) => check.id === "contract.daemon.invocations")?.message ?? "",
    /daemon\.invocations/,
  );
});

void test("daemon readiness reports missing daemon.running with contract path", () => {
  const report = evaluateDaemonReadiness({
    action: "status",
    daemon: {
      invocations: { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
    },
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
  observedAt?: string;
  invocationHealth?: { oldestQueuedAt?: string; oldestRunningAt?: string };
  invocations: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  servers?: Array<Record<string, unknown>>;
}): unknown {
  return {
    action: "status",
    daemon: {
      running: overrides.running ?? true,
      pid: 123,
      socketPath: "/tmp/spark-test.sock",
      startedAt: "2030-01-01T00:00:00.000Z",
      observedAt: overrides.observedAt,
      invocations: overrides.invocations,
      invocationHealth: overrides.invocationHealth,
      servers: overrides.servers ?? [],
    },
  };
}
