import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";

import { helpText, parseSparkDispatcherArgs } from "../apps/spark-cli/src/cli.ts";
import { sparkDaemonHelpText } from "../apps/spark-tui/src/cli/daemon.ts";
import { sparkTuiCliStrings } from "../packages/spark-i18n/src/cli.ts";
import {
  extractDaemonStatusContract,
  extractServerStatusContract,
} from "../test/support/spark-plane-contracts.mts";

const execFileAsync = promisify(execFile);

const CONTRACT_PATH = new URL("../docs/specs/command-planes.md", import.meta.url);
const DEPRECATIONS_PATH = new URL(
  "./fixtures/spark-command-plane-deprecations.json",
  import.meta.url,
);

void test("command-plane contract documents canonical namespaces and server/cockpit meaning", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  for (const expected of [
    "`spark daemon` | daemon execution plane",
    "`spark server` | server coordination plane",
    "`spark cockpit` | Cockpit web UI host",
    "`spark tui` | tui local control plane",
    "slash `system` | TUI kernel command source",
    "slash `extension` | extension command source",
  ]) {
    assert.match(contract, new RegExp(escapeRegExp(expected), "u"), expected);
  }
  assert.match(
    contract,
    /`spark server` is the coordination plane, not a network service in this phase/u,
  );
});

void test("command-plane contract uses singular canonical resources and marks disallowed shapes", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  assert.match(contract, /spark daemon session list --json/u);
  assert.match(contract, /spark server task list/u);
  assert.match(contract, /spark tui attach <session-id>/u);
  assert.match(contract, /spark daemon sessions list --all-workspaces/u);
  assert.match(contract, /spark daemon task claim <task-ref>/u);
  assert.match(contract, /spark server queue clear/u);

  assert.deepEqual(parseSparkDispatcherArgs(["server", "task", "list"]), {
    kind: "dispatch",
    target: "server",
    argv: ["task", "list"],
  });
});

void test("dispatcher, daemon, server, and TUI help snapshots expose the three-plane model", async () => {
  const dispatcherHelp = helpText();
  assert.match(dispatcherHelp, /spark daemon\s+daemon execution plane/u);
  assert.match(dispatcherHelp, /spark server\s+server coordination plane/u);
  assert.match(dispatcherHelp, /spark cockpit\s+launch the Cockpit web UI/u);
  assert.match(dispatcherHelp, /spark tui\s+tui local control plane/u);
  assert.doesNotMatch(dispatcherHelp, /spark daemon sessions list --all-workspaces/u);

  const daemonHelp = sparkDaemonHelpText();
  assert.match(daemonHelp, /spark daemon - daemon execution plane/u);
  assert.match(daemonHelp, /spark daemon session list \[--json\]/u);
  assert.match(daemonHelp, /spark daemon run list \[--json\]/u);
  assert.match(daemonHelp, /spark daemon events watch \[--json\]/u);
  assert.match(daemonHelp, /server coordination plane/u);
  assert.doesNotMatch(daemonHelp, /task claim/u);
  assert.doesNotMatch(daemonHelp, /goal complete/u);
  assert.doesNotMatch(daemonHelp, /spark daemon sessions list --all-workspaces/u);

  const { stdout: cockpitHelp } = await execFileAsync(
    fileURLToPath(new URL("../apps/spark-cockpit/bin/spark-cockpit", import.meta.url)),
    ["--help"],
  );
  assert.match(cockpitHelp, /spark cockpit - Cockpit web UI host/u);
  assert.match(cockpitHelp, /Cockpit is the web UI host, not a fourth command plane/u);
  assert.match(cockpitHelp, /Coordination commands belong under spark server/u);

  const tuiHelp = sparkTuiCliStrings().helpText;
  assert.match(tuiHelp, /spark daemon\s+daemon execution plane/u);
  assert.match(tuiHelp, /spark server\s+server coordination plane/u);
  assert.match(tuiHelp, /spark tui\s+tui local control plane/u);
  assert.doesNotMatch(tuiHelp, /spark daemon sessions list --all-workspaces/u);
});

void test("daemon and server status JSON contracts validate current envelopes", () => {
  const daemon = extractDaemonStatusContract({
    action: "status",
    daemon: {
      running: true,
      pid: 123,
      socketPath: "/tmp/spark-test.sock",
      startedAt: "2030-01-01T00:00:00.000Z",
      queue: { inbox: 0, processed: 2, failed: 0 },
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    },
  });
  assert.equal(daemon.running, true);
  assert.deepEqual(daemon.queue, { inbox: 0, processed: 2, failed: 0 });
  assert.equal(daemon.workspaceCount, 1);
  assert.equal(daemon.websocketState, "connected");
  assert.deepEqual(daemon.diagnostics, []);

  const server = extractServerStatusContract({
    action: "status",
    result: {
      plane: "server",
      resource: "status",
      currentProjectRef: "proj:test",
      projectCount: 1,
      taskCounts: { total: 1, unfinished: 0, ready: 0 },
      scope: {
        selectedWorkspace: "/tmp/workspace",
        selectedSessionKey: "session:test",
        selectedProjectRef: "proj:test",
        goalSource: "current-project",
      },
    },
  });
  assert.equal(server.plane, "server");
  assert.equal(server.resource, "status");
  assert.equal(server.currentProjectRef, "proj:test");
  assert.equal(server.projectCount, 1);
  assert.deepEqual(server.diagnostics, []);
});

void test("daemon status contract reports malformed envelopes with field paths", () => {
  const missingQueue = extractDaemonStatusContract({ action: "status", daemon: { running: true } });
  assert.equal(
    missingQueue.diagnostics.some((diagnostic) => diagnostic.path === "daemon.queue"),
    true,
  );
  assert.match(
    missingQueue.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    /daemon\.queue/u,
  );

  const missingRunning = extractDaemonStatusContract({
    action: "status",
    daemon: { queue: { inbox: 0, processed: 1, failed: 0 } },
  });
  assert.equal(
    missingRunning.diagnostics.some((diagnostic) => diagnostic.path === "daemon.running"),
    true,
  );
  assert.match(
    missingRunning.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    /daemon\.running/u,
  );
});

void test("server status contract reports malformed envelopes with field paths", () => {
  const malformed = extractServerStatusContract({
    action: "status",
    result: { plane: "daemon", resource: "status", scope: {} },
  });
  assert.equal(
    malformed.diagnostics.some((diagnostic) => diagnostic.path === "result.plane"),
    true,
  );
  assert.equal(
    malformed.diagnostics.some((diagnostic) => diagnostic.path === "result.taskCounts"),
    true,
  );
  assert.equal(
    malformed.diagnostics.some(
      (diagnostic) => diagnostic.path === "result.scope.selectedWorkspace",
    ),
    true,
  );
});

void test("deprecation map covers legacy slash aliases with canonical targets", async () => {
  const rows = JSON.parse(await readFile(DEPRECATIONS_PATH, "utf8")) as Array<{
    legacy?: string;
    canonicalSlash?: string;
    canonicalCliTarget?: string;
    status?: string;
  }>;
  const byLegacy = new Map(rows.map((row) => [row.legacy, row]));
  for (const legacy of [
    "/tasks",
    "/sessions",
    "/workflow-runs",
    "/workflow-pause",
    "/workflow-resume",
    "/workflow-stop",
    "/fork",
  ]) {
    const row = byLegacy.get(legacy);
    assert.equal(Boolean(row), true, legacy);
    assert.equal(typeof row?.canonicalSlash, "string", `${legacy}.canonicalSlash`);
    assert.equal(typeof row?.canonicalCliTarget, "string", `${legacy}.canonicalCliTarget`);
    assert.match(row?.status ?? "", /deprecated alias|removed/u, `${legacy}.status`);
  }
  assert.equal(byLegacy.get("/sessions")?.canonicalCliTarget, "spark daemon session list");
  assert.equal(byLegacy.get("/tasks")?.canonicalCliTarget, "spark server task list");
  assert.equal(byLegacy.get("/fork")?.canonicalCliTarget, "spark daemon session fork --current");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
