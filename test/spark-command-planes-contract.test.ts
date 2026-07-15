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
  extractCockpitStatusContract,
} from "../test/support/spark-plane-contracts.mts";

const execFileAsync = promisify(execFile);

const CONTRACT_PATH = new URL("../docs/specs/command-planes.md", import.meta.url);
const DEPRECATIONS_PATH = new URL(
  "./fixtures/spark-command-plane-deprecations.json",
  import.meta.url,
);

void test("command-plane contract documents the three canonical namespaces", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  for (const expected of [
    "`spark daemon` | daemon execution plane",
    "`spark cockpit` | coordination plane and web UI host",
    "`spark tui` | tui local control plane",
    "slash `system` | TUI kernel command source",
    "slash `extension` | extension command source",
  ]) {
    assert.match(contract, new RegExp(escapeRegExp(expected), "u"), expected);
  }
  assert.match(contract, /`spark cockpit` is both the coordination CLI and the web UI host/u);
});

void test("command-plane contract uses singular canonical resources and marks disallowed shapes", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  assert.match(contract, /spark daemon session list --json/u);
  assert.match(contract, /spark cockpit task list/u);
  assert.match(contract, /spark tui attach <session-id>/u);
  assert.match(contract, /spark daemon sessions list --all-workspaces/u);
  assert.match(contract, /spark daemon task claim <task-ref>/u);
  assert.match(contract, /spark cockpit invocation status <invocation-id>/u);
  assert.match(contract, /spark server status/u);

  assert.deepEqual(parseSparkDispatcherArgs(["server", "task", "list"]), {
    kind: "error",
    message: 'The "spark server" namespace was removed. Use "spark cockpit" instead.',
  });
});

void test("dispatcher, daemon, Cockpit, and TUI help snapshots expose the three-surface model", async () => {
  const dispatcherHelp = helpText();
  assert.match(dispatcherHelp, /spark daemon\s+daemon execution plane/u);
  assert.match(
    dispatcherHelp,
    /spark cockpit\s+cross-daemon coordination and Web presentation host/u,
  );
  assert.match(dispatcherHelp, /spark tui\s+tui local control plane/u);
  assert.doesNotMatch(dispatcherHelp, /spark daemon sessions list --all-workspaces/u);

  const daemonHelp = sparkDaemonHelpText();
  assert.match(daemonHelp, /spark daemon - daemon execution plane/u);
  assert.match(daemonHelp, /spark daemon session list \[--json\]/u);
  assert.match(daemonHelp, /spark daemon session mailto --to <session-id>/u);
  assert.match(daemonHelp, /spark daemon session inbox --session <session-id>/u);
  assert.match(daemonHelp, /spark daemon run list \[--json\]/u);
  assert.match(daemonHelp, /spark daemon events watch \[--json\]/u);
  assert.match(
    daemonHelp,
    /Project\/task\/goal\/review\/assign commands belong under spark cockpit/u,
  );
  assert.doesNotMatch(daemonHelp, /belong under spark server/u);
  assert.doesNotMatch(daemonHelp, /task claim/u);
  assert.doesNotMatch(daemonHelp, /goal complete/u);
  assert.doesNotMatch(daemonHelp, /spark daemon sessions list --all-workspaces/u);
  assert.doesNotMatch(daemonHelp, /spark sessions mailto/u);
  assert.doesNotMatch(daemonHelp, /spark sessions inbox/u);

  const { stdout: cockpitHelp } = await execFileAsync(
    fileURLToPath(new URL("../apps/spark-cockpit/bin/spark-cockpit", import.meta.url)),
    ["--help"],
  );
  assert.match(cockpitHelp, /spark cockpit - Spark cross-daemon coordination and Web cockpit/u);
  assert.match(cockpitHelp, /Cockpit coordinates across daemon execution planes/u);
  assert.doesNotMatch(cockpitHelp, /\b(?:dev|build|preview)\b/u);
  assert.match(cockpitHelp, /SPARK_COCKPIT_PUBLIC_URL=https:\/\//u);
  assert.match(cockpitHelp, /SPARK_COCKPIT_TRUST_PROXY=loopback/u);

  const tuiHelp = sparkTuiCliStrings().helpText;
  assert.match(tuiHelp, /spark daemon\s+daemon execution plane/u);
  assert.match(tuiHelp, /spark cockpit\s+cross-daemon coordination and Web presentation host/u);
  assert.match(tuiHelp, /spark tui\s+tui local control plane/u);
  assert.doesNotMatch(tuiHelp, /spark daemon sessions list --all-workspaces/u);
});

void test("root dispatcher reaches Cockpit and rejects the removed server namespace", async () => {
  const dispatcher = fileURLToPath(new URL("../apps/spark-cli/bin/spark", import.meta.url));
  const { stdout, stderr } = await execFileAsync(dispatcher, ["cockpit", "--help"]);
  assert.match(stdout, /spark cockpit - Spark cross-daemon coordination and Web cockpit/u);
  assert.equal(stderr, "");

  await assert.rejects(execFileAsync(dispatcher, ["server", "status"]), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 2);
    assert.match(failure.stderr ?? "", /Use "spark cockpit" instead/u);
    return true;
  });
});

void test("daemon and Cockpit status JSON contracts validate current envelopes", () => {
  const daemon = extractDaemonStatusContract({
    action: "status",
    daemon: {
      running: true,
      pid: 123,
      socketPath: "/tmp/spark-test.sock",
      startedAt: "2030-01-01T00:00:00.000Z",
      invocations: { queued: 0, running: 0, succeeded: 2, failed: 0, cancelled: 0 },
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    },
  });
  assert.equal(daemon.running, true);
  assert.deepEqual(daemon.invocations, {
    queued: 0,
    running: 0,
    succeeded: 2,
    failed: 0,
    cancelled: 0,
  });
  assert.equal(daemon.workspaceCount, 1);
  assert.equal(daemon.websocketState, "connected");
  assert.deepEqual(daemon.diagnostics, []);

  const cockpit = extractCockpitStatusContract({
    action: "status",
    result: {
      plane: "cockpit",
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
  assert.equal(cockpit.plane, "cockpit");
  assert.equal(cockpit.resource, "status");
  assert.equal(cockpit.currentProjectRef, "proj:test");
  assert.equal(cockpit.projectCount, 1);
  assert.deepEqual(cockpit.diagnostics, []);
});

void test("daemon status contract reports malformed envelopes with field paths", () => {
  const missingInvocations = extractDaemonStatusContract({
    action: "status",
    daemon: { running: true },
  });
  assert.equal(
    missingInvocations.diagnostics.some((diagnostic) => diagnostic.path === "daemon.invocations"),
    true,
  );
  assert.match(
    missingInvocations.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    /daemon\.invocations/u,
  );

  const missingRunning = extractDaemonStatusContract({
    action: "status",
    daemon: {
      invocations: { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
    },
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

void test("Cockpit status contract reports malformed envelopes with field paths", () => {
  const malformed = extractCockpitStatusContract({
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
  assert.equal(byLegacy.get("/tasks")?.canonicalCliTarget, "spark cockpit task list");
  assert.equal(byLegacy.get("/fork")?.canonicalCliTarget, "spark daemon session fork --current");

  for (const row of rows) {
    const [root, ...argv] = row.canonicalCliTarget?.split(/\s+/u) ?? [];
    assert.equal(root, "spark", `${row.legacy}.canonicalCliTarget root`);
    assert.doesNotMatch(
      row.canonicalCliTarget ?? "",
      /^spark server\b/u,
      row.legacy ?? "unknown legacy alias",
    );
    const command = parseSparkDispatcherArgs(argv);
    if (command.kind !== "dispatch") {
      assert.fail(`${row.legacy} canonical target is not dispatcher-reachable`);
    }
    assert.equal(command.target, argv[0], `${row.legacy} dispatcher target`);
    assert.deepEqual(command.argv, argv.slice(1), `${row.legacy} dispatcher argv`);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
