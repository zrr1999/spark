import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "vitest";

import { parseSparkDispatcherArgs } from "../apps/spark-cli/src/cli.ts";
import {
  extractDaemonStatusContract,
  extractCockpitStatusContract,
} from "../test/support/spark-plane-contracts.mts";

const execFileAsync = promisify(execFile);

const DEPRECATIONS_PATH = new URL(
  "./fixtures/spark-command-plane-deprecations.json",
  import.meta.url,
);

test("root dispatcher reaches Cockpit and rejects the removed server namespace", async () => {
  assert.deepEqual(parseSparkDispatcherArgs(["server", "task", "list"]), {
    kind: "error",
    message: 'The "spark server" namespace was removed. Use "spark cockpit" instead.',
  });

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
  await assert.rejects(
    execFileAsync(dispatcher, ["server", "instance", "status"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 2);
      assert.match(failure.stderr ?? "", /Use "spark cockpit" instead/u);
      return true;
    },
  );
});

test("daemon and Cockpit status JSON contracts validate current envelopes", () => {
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

test("daemon status contract reports malformed envelopes with field paths", () => {
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

test("Cockpit status contract reports malformed envelopes with field paths", () => {
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

test("deprecation map covers legacy slash aliases with canonical targets", async () => {
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
