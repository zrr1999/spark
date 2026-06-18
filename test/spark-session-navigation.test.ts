import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  SparkHostRuntime,
  SparkSessionStore,
  buildSparkSessionTree,
  flattenSparkSessionTree,
  getSparkSessionBranch,
  registerSparkSessionsCommand,
  switchSparkSessionLeaf,
  type SparkSessionEntry,
  type SparkSessionRecord,
} from "../apps/spark/src/host/index.ts";
import { createSparkSessionTreeComponent } from "../apps/spark/src/tui/session-tree.ts";

function makeBranchedRecord(store: SparkSessionStore): SparkSessionRecord {
  const record = store.createSession({ id: "nav", timestamp: "2026-06-03T04:00:00.000Z" });
  const rootId = store.appendMessage(record, { role: "user", content: "root prompt" });
  store.appendMessage(record, { role: "assistant", content: "main answer" });
  record.entries.push({
    type: "message",
    id: "branch-user",
    parentId: rootId,
    timestamp: "2026-06-03T04:00:03.000Z",
    message: { role: "user", content: "alternate prompt" },
  });
  record.entries.push({
    type: "label",
    id: "label-branch",
    parentId: "branch-user",
    timestamp: "2026-06-03T04:00:04.000Z",
    targetId: "branch-user",
    label: "Alt branch",
  });
  return record;
}

void test("session navigation builds Pi-style branch trees, labels, flatten rows, and branch paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-nav-tree-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = makeBranchedRecord(store);

    const tree = buildSparkSessionTree(record);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.children.length, 2);

    const rows = flattenSparkSessionTree(record, "branch-user");
    const branchRow = rows.find((row) => row.id === "branch-user")!;
    assert.equal(branchRow.active, true);
    assert.equal(branchRow.label, "Alt branch");
    assert.equal(branchRow.depth, 1);

    assert.deepEqual(
      getSparkSessionBranch(record, "branch-user").map((entry) => entry.id),
      [record.entries[0]!.id, "branch-user"],
    );
    assert.equal(switchSparkSessionLeaf(record, "branch-user"), "branch-user");
    assert.throws(
      () => switchSparkSessionLeaf(record, "missing"),
      /Session entry not found: missing/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/sessions command supports list, branch, and switch subcommands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-nav-command-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = makeBranchedRecord(store);
    await store.save(record);

    let activeLeafId: string | null = record.entries.at(-1)?.id ?? null;
    const notifications: Array<{ message: string; level?: string }> = [];
    const host = new SparkHostRuntime({ cwd: store.cwd, hasUI: true });
    host.setUiTransport({ notify: (message, level) => notifications.push({ message, level }) });
    registerSparkSessionsCommand(host, {
      store,
      getNavigationState: () => ({ record, activeLeafId }),
      setActiveLeafId: (leafId) => {
        activeLeafId = leafId;
      },
    });

    const command = host.getCommand("sessions")!;
    await command.handler("list", host.makeContext());
    await command.handler("branch", host.makeContext());
    await command.handler("switch branch-user", host.makeContext());
    await command.handler("switch missing", host.makeContext());

    assert.match(notifications[0]!.message, /nav/);
    assert.match(notifications[1]!.message, /Alt branch/);
    assert.equal(notifications[2]!.message, "Active session branch: branch-user");
    assert.equal(notifications[2]!.level, "info");
    assert.equal(activeLeafId, "branch-user");
    assert.match(notifications[3]!.message, /Session entry not found: missing/);
    assert.equal(notifications[3]!.level, "error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark session tree SelectList wrapper renders bounded rows and selects active row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-nav-tui-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = makeBranchedRecord(store);
    const rows = flattenSparkSessionTree(record, "branch-user");
    let selected: string | undefined;
    const component = createSparkSessionTreeComponent({
      rows,
      onSelect: (leafId) => {
        selected = leafId;
      },
    });

    const rendered = component.render(64);
    assert.equal(
      rendered.some((line) => line.includes("Session Branches")),
      true,
    );
    assert.equal(
      rendered.some((line) => line.includes("Alt branch")),
      true,
    );
    assert.equal(
      rendered.every((line) => visibleWidth(line) <= 64),
      true,
    );

    (component as { handleInput(data: string): void }).handleInput("\r");
    assert.equal(selected, "branch-user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("branch helpers treat orphan entries as roots and branch leaves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-nav-orphan-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = store.createSession({ id: "orphan", timestamp: "2026-06-03T05:00:00.000Z" });
    const orphan: SparkSessionEntry = {
      type: "message",
      id: "orphan-entry",
      parentId: "missing-parent",
      timestamp: "2026-06-03T05:00:01.000Z",
      message: { role: "user", content: "orphan" },
    };
    record.entries.push(orphan);

    const tree = buildSparkSessionTree(record);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.entry.id, "orphan-entry");
    assert.deepEqual(
      getSparkSessionBranch(record, "orphan-entry").map((entry) => entry.id),
      ["orphan-entry"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
