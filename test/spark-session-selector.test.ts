import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@zendev-lab/spark-tui/text";
import type { Component } from "../apps/spark-tui/src/tui/pi-tui-adapter.ts";
import {
  CREATE_SPARK_SESSION_SELECTION,
  createSparkSessionSelectorComponent,
  formatSparkSessionListByWorkspace,
  isSelectableSparkSession,
  selectSparkSessionFromCustomUi,
} from "../apps/spark-tui/src/tui/session-selector.ts";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import type {
  SparkModelSelectorCustomUi,
  SparkModelSelectorTheme,
  SparkModelSelectorTuiLike,
} from "../apps/spark-tui/src/tui/model-selector.ts";

const sessions = [
  {
    sessionId: "session-recent",
    title: "Recent conversation",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    workspaceId: "workspace-1",
    status: "ready" as const,
    model: { providerName: "openai", modelId: "gpt-5" },
    thinkingLevel: "high" as const,
    bindings: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
  },
];

const untitledSession: SparkSessionRegistryRecord = {
  sessionId: "session-untitled",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T02:00:00.000Z",
};

const archivedSession: SparkSessionRegistryRecord = {
  sessionId: "session-archived",
  title: "Archived conversation",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "archived",
  bindings: [],
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T01:00:00.000Z",
};

const channelBindingSession: SparkSessionRegistryRecord = {
  sessionId: "session-channel-bound",
  title: "Ops room",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "ready",
  bindings: [{ kind: "channel", adapter: "feishu", externalKey: "feishu:chat:oc_ops" }],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T02:00:00.000Z",
};

const channelTitleSession: SparkSessionRegistryRecord = {
  sessionId: "session-channel-title",
  title: "channel qqbot:c2c:398418FB5E7F1C597DFFD117597D6500",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T02:00:00.000Z",
};

const otherWorkspaceSession: SparkSessionRegistryRecord = {
  sessionId: "session-other-workspace",
  title: "Other workspace",
  scope: { kind: "workspace", workspaceId: "workspace-2" },
  workspaceId: "workspace-2",
  cwd: "/workspace/other",
  status: "running",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T03:00:00.000Z",
};

const legacyWorkspaceSession: SparkSessionRegistryRecord = {
  sessionId: "session-legacy-workspace",
  title: "Legacy workspace",
  scope: { kind: "workspace", workspaceId: "spark" },
  workspaceId: "spark",
  cwd: "/workspace/spark",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T03:30:00.000Z",
};

const daemonSession: SparkSessionRegistryRecord = {
  sessionId: "session-daemon",
  title: "Daemon conversation",
  scope: { kind: "daemon", daemonId: "daemon-1" },
  cwd: "/daemon",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T04:00:00.000Z",
};

void test("Spark session selector renders new and daemon-managed session choices", () => {
  const selected: string[] = [];
  const component = createSparkSessionSelectorComponent({
    sessions,
    workspaceId: "workspace-1",
    workspaceLabel: "spark • /workspace/spark",
    onSelect: (value) => selected.push(value),
  });

  const lines = component.render(72);
  assert.equal(
    lines.some((line) => line.includes("Open Spark Session")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("+ New session")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("openai/gpt-5")),
    true,
  );
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 72),
    true,
  );

  component.handleInput?.("\r");
  assert.deepEqual(selected, [CREATE_SPARK_SESSION_SELECTION]);
});

void test("Spark session selector uses the Cockpit fallback for untitled sessions", () => {
  const component = createSparkSessionSelectorComponent({
    sessions: [untitledSession],
    workspaceId: "workspace-1",
    workspaceLabel: "spark • /workspace/spark",
    onSelect: () => undefined,
  });

  const lines = component.render(72);
  assert.equal(
    lines.some((line) => line.includes("New conversation")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("session-untitled")),
    true,
  );
});

void test("Spark session selector switches workspace groups horizontally", () => {
  const selected: string[] = [];
  const component = createSparkSessionSelectorComponent({
    sessions: [
      ...(sessions as SparkSessionRegistryRecord[]),
      archivedSession,
      channelBindingSession,
      channelTitleSession,
      otherWorkspaceSession,
      legacyWorkspaceSession,
      daemonSession,
    ],
    workspaceId: "workspace-1",
    workspaceLabel: "spark • /workspace/spark",
    workspaces: [
      {
        id: "workspace-2",
        canonicalId: "workspace-2",
        displayName: "spore",
        localPath: "/workspace/spark",
      },
      {
        id: "spark",
        canonicalId: "workspace-1",
        displayName: "spark",
        localPath: "/workspace/spark",
      },
    ],
    maxVisible: 20,
    onSelect: (value) => selected.push(value),
  });

  let lines = component.render(96);
  assert.equal(
    lines.some((line) => line.includes("[spark (4)]")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("spore (1)")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("TUI only (1)")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Legacy workspace")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Archived conversation")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("Ops room")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("feishu")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Other workspace")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("Daemon conversation")),
    false,
  );

  component.handleInput?.("\u001b[C");
  lines = component.render(96);
  assert.equal(
    lines.some((line) => line.includes("[spore (1)]")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Other workspace")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    false,
  );

  component.handleInput?.("\u001b[C");
  lines = component.render(96);
  assert.equal(
    lines.some((line) => line.includes("[TUI only (1)]")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Daemon conversation")),
    true,
  );
  component.handleInput?.("\r");
  assert.deepEqual(selected, [daemonSession.sessionId]);
});

void test("isSelectableSparkSession matches the daemon default non-archived list", () => {
  assert.equal(isSelectableSparkSession(sessions[0] as SparkSessionRegistryRecord), true);
  assert.equal(isSelectableSparkSession(archivedSession), false);
  assert.equal(isSelectableSparkSession(channelBindingSession), true);
  assert.equal(isSelectableSparkSession(channelTitleSession), true);
});

void test("Spark session list text uses the same workspace groups as the selector", () => {
  const text = formatSparkSessionListByWorkspace({
    sessions: [
      ...(sessions as SparkSessionRegistryRecord[]),
      channelBindingSession,
      otherWorkspaceSession,
      daemonSession,
    ],
    workspaceId: "workspace-1",
    workspaceLabel: "spark • /workspace/spark",
    workspaces: [
      {
        id: "workspace-2",
        canonicalId: "workspace-2",
        displayName: "spore",
        localPath: "/workspace/spark",
      },
    ],
  });

  assert.match(text, /^Spark daemon sessions:/u);
  assert.match(text, /spark • \/workspace\/spark \(2\)/u);
  assert.match(text, /spore • \/workspace\/spark \(1\)/u);
  assert.match(text, /TUI only \(1\)/u);
  assert.match(text, /Ops room • session-channel-bound • feishu/u);
});

void test("Spark session selector custom UI returns an existing daemon session", async () => {
  let overlayEnabled = false;
  let rendered = false;
  const customUi: SparkModelSelectorCustomUi = {
    custom<T>(
      factory: (
        tui: SparkModelSelectorTuiLike,
        theme: SparkModelSelectorTheme,
        keybindings: unknown,
        done: (value: T) => void,
      ) => Component,
      options?: unknown,
    ): T {
      overlayEnabled =
        typeof options === "object" &&
        options !== null &&
        (options as { overlay?: unknown }).overlay === true;
      const component = factory(
        { requestRender: () => undefined },
        {},
        undefined,
        (_value: T) => undefined,
      );
      rendered = component.render(72).some((line) => line.includes("Recent conversation"));
      return "session-recent" as T;
    },
  };

  const selection = await selectSparkSessionFromCustomUi(customUi, {
    sessions,
    workspaceId: "workspace-1",
    workspaceLabel: "spark • /workspace/spark",
  });
  assert.equal(rendered, true);
  assert.equal(overlayEnabled, true);
  assert.equal(selection, "session-recent");
});
