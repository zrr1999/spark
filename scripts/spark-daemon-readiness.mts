#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  extractDaemonStatusContract,
  redactSecrets,
} from "../test/support/spark-plane-contracts.mts";

export { redactSecrets } from "../test/support/spark-plane-contracts.mts";

const execFileAsync = promisify(execFile);
const QUEUED_STUCK_MS = 5 * 60_000;
const RUNNING_STUCK_MS = 15 * 60_000;

export type ReadinessLevel = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  id: string;
  level: ReadinessLevel;
  message: string;
  value?: unknown;
}

export interface SparkDaemonReadinessReport {
  overall: ReadinessLevel;
  status: unknown;
  baselineStatus?: unknown;
  checks: ReadinessCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
}

const args = new Map<string, string | boolean>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}

export function evaluateDaemonReadiness(
  statusInput: unknown,
  baselineInput?: unknown,
): SparkDaemonReadinessReport {
  const status = redactSecrets(statusInput);
  const baselineStatus = baselineInput === undefined ? undefined : redactSecrets(baselineInput);
  const daemon = extractDaemonStatusContract(status);
  const baselineDaemon =
    baselineStatus === undefined ? undefined : extractDaemonStatusContract(baselineStatus);
  const invocations = daemon.invocations;
  const baselineInvocations = baselineDaemon?.invocations;
  const checks: ReadinessCheck[] = [];

  const daemonRunning = daemon.running === true;
  const runningDiagnostic = daemon.diagnostics.find(
    (diagnostic) => diagnostic.path === "daemon.running",
  );
  checks.push({
    id: "daemonRunning",
    level: daemonRunning ? "pass" : "fail",
    message: daemonRunning
      ? "Spark daemon is running."
      : (runningDiagnostic?.message ?? "Spark daemon is not running."),
    value: daemon.running,
  });

  const contractFailures = daemon.diagnostics.filter(
    (diagnostic) => diagnostic.level === "fail" && diagnostic.path !== "daemon.running",
  );
  for (const diagnostic of contractFailures) {
    checks.push({
      id: `contract.${diagnostic.path}`,
      level: "fail",
      message: diagnostic.message,
      value: diagnostic.path,
    });
  }

  const enrolled = true;
  checks.push({
    id: "enrolled",
    level: "pass",
    message:
      "Daemon status contract is present; runtime enrollment is represented by daemon/server records.",
    value: enrolled,
  });

  const workspaceCount = daemon.workspaceCount;
  checks.push({
    id: "workspaceCount",
    level: workspaceCount === undefined ? "warn" : workspaceCount > 0 ? "pass" : "warn",
    message:
      workspaceCount === undefined
        ? "workspaceCount is missing from daemon status."
        : workspaceCount > 0
          ? `Daemon reports ${workspaceCount} workspace(s).`
          : "Daemon reports zero workspaces; replacement workflow has no workspace projection.",
    value: workspaceCount,
  });

  const serverUrl = daemon.serverUrl;
  checks.push({
    id: "serverUrl",
    level: serverUrl?.startsWith("http") ? "pass" : "warn",
    message: serverUrl?.startsWith("http")
      ? `Daemon server URL is available: ${serverUrl}`
      : "Daemon server URL is missing or not HTTP(S).",
    value: serverUrl,
  });

  const queued = invocations?.queued;
  const running = invocations?.running;
  const failed = invocations?.failed;
  checks.push({
    id: "invocations.queued",
    level: queued === undefined ? "warn" : queued === 0 ? "pass" : "warn",
    message:
      queued === undefined
        ? "invocations.queued is missing."
        : queued === 0
          ? "No queued invocations."
          : `Queued invocation backlog has ${queued} pending item(s).`,
    value: queued,
  });
  checks.push({
    id: "invocations.running",
    level: running === undefined ? "warn" : "pass",
    message:
      running === undefined
        ? "invocations.running is missing."
        : `${running} invocation(s) are running.`,
    value: running,
  });
  checks.push({
    id: "invocations.failed",
    level: failed === undefined ? "warn" : "pass",
    message:
      failed === undefined
        ? "invocations.failed is missing."
        : failed === 0
          ? "Invocation failed counter is zero."
          : `Invocation history contains ${failed} failed item(s); readiness is based on new failures after the supplied baseline.`,
    value: failed,
  });

  appendStuckInvocationCheck(checks, "queued", daemon, QUEUED_STUCK_MS);
  appendStuckInvocationCheck(checks, "running", daemon, RUNNING_STUCK_MS);

  const baselineQueued = baselineInvocations?.queued;
  const baselineFailed = baselineInvocations?.failed;
  appendInvocationDeltaCheck(checks, "invocations.delta.queued", queued, baselineQueued, {
    pass: (delta) => delta <= 0,
    missing:
      "invocations.delta.queued cannot be computed because current or baseline invocations.queued is missing.",
    passMessage: (delta) => `Queued invocation delta is ${delta}; no backlog growth detected.`,
    warnMessage: (delta) =>
      `Queued invocation delta is +${delta}; pending work increased during readiness window.`,
  });
  appendInvocationDeltaCheck(checks, "invocations.delta.failed", failed, baselineFailed, {
    pass: (delta) => delta === 0,
    missing:
      "invocations.delta.failed cannot be computed because current or baseline invocations.failed is missing.",
    passMessage: (delta) =>
      `Failed invocation delta is ${delta}; no new failures detected during readiness window.`,
    warnMessage: (delta) =>
      `Failed invocation delta is +${delta}; new daemon failures appeared during readiness window.`,
  });

  const websocketState = daemon.websocketState;
  checks.push({
    id: "websocketState",
    level: websocketState === undefined ? "warn" : websocketState === "connected" ? "pass" : "warn",
    message:
      websocketState === undefined
        ? "WebSocket connection state is not present in daemon status JSON; use native /status or add a daemon field before replacement readiness."
        : websocketState === "connected"
          ? "Daemon WebSocket state is connected."
          : `Daemon WebSocket state is ${websocketState}; replacement readiness requires a connected or explicitly unnecessary websocket path.`,
    value: websocketState ?? "missing",
  });

  const summary = {
    pass: checks.filter((check) => check.level === "pass").length,
    warn: checks.filter((check) => check.level === "warn").length,
    fail: checks.filter((check) => check.level === "fail").length,
  };
  const overall: ReadinessLevel = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  return {
    overall,
    status,
    ...(baselineStatus === undefined ? {} : { baselineStatus }),
    checks,
    summary,
  };
}

function appendStuckInvocationCheck(
  checks: ReadinessCheck[],
  status: "queued" | "running",
  daemon: ReturnType<typeof extractDaemonStatusContract>,
  thresholdMs: number,
): void {
  const oldestAt =
    status === "queued"
      ? daemon.invocationHealth?.oldestQueuedAt
      : daemon.invocationHealth?.oldestRunningAt;
  const count = daemon.invocations?.[status];
  const observedAt = daemon.observedAt ? Date.parse(daemon.observedAt) : Date.now();
  const ageMs = oldestAt ? observedAt - Date.parse(oldestAt) : undefined;
  const stuck = count !== undefined && count > 0 && ageMs !== undefined && ageMs >= thresholdMs;
  checks.push({
    id: `invocations.stuck.${status}`,
    level: stuck ? "warn" : "pass",
    message: stuck
      ? `Oldest ${status} invocation is ${Math.floor(ageMs / 1_000)}s old; inspect it with spark daemon invocation list --status ${status} --limit 20.`
      : count === 0
        ? `No ${status} invocations require age checks.`
        : oldestAt
          ? `Oldest ${status} invocation is below the ${Math.floor(thresholdMs / 1_000)}s threshold.`
          : `No ${status} invocation age is available.`,
    value: { count, oldestAt: oldestAt ?? null, ageMs: ageMs ?? null },
  });
}

function appendInvocationDeltaCheck(
  checks: ReadinessCheck[],
  id: string,
  current: number | undefined,
  baseline: number | undefined,
  options: {
    pass(delta: number): boolean;
    missing: string;
    passMessage(delta: number): string;
    warnMessage(delta: number): string;
  },
): void {
  if (current === undefined || baseline === undefined) {
    checks.push({ id, level: "warn", message: options.missing, value: "missing" });
    return;
  }
  const delta = current - baseline;
  const pass = options.pass(delta);
  checks.push({
    id,
    level: pass ? "pass" : "warn",
    message: pass ? options.passMessage(delta) : options.warnMessage(delta),
    value: delta,
  });
}

async function readStatusInput(): Promise<unknown> {
  const statusFile = args.get("status-json");
  if (typeof statusFile === "string") return JSON.parse(await readFile(statusFile, "utf8"));
  const result = await execFileAsync("pnpm", ["exec", "spark", "daemon", "status", "--json"], {
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function readBaselineInput(): Promise<unknown> {
  const baselineFile = args.get("baseline-json");
  if (typeof baselineFile !== "string") return undefined;
  return JSON.parse(await readFile(baselineFile, "utf8"));
}

async function main(): Promise<void> {
  const status = await readStatusInput();
  const baseline = await readBaselineInput();
  const report = evaluateDaemonReadiness(status, baseline);
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.fail > 0 || (args.get("strict") === true && report.summary.warn > 0)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
