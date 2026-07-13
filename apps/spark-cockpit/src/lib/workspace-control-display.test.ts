import { describe, expect, it } from "vitest";
import { getDictionary } from "./i18n";
import { workspaceControlControlLabel, workspaceControlDisplay } from "./workspace-control-display";

const en = getDictionary("en").home.workspaceControl;
const zhCN = getDictionary("zh-CN").home.workspaceControl;

describe("workspace control display", () => {
  it("renders borrowed and online executor state for Cockpit", () => {
    expect(
      workspaceControlDisplay(
        {
          connection: { status: "connected", lastSeenAt: "2026-05-22T00:00:00.000Z" },
          borrowed: { borrowed: true, interactiveClientCount: 1 },
          executor: { state: "online", activeInvocationCount: 2, activeAgentCount: 3 },
          control: {
            mode: "snapshot_only",
            reason: "workspace_borrowed",
            serverMutationAllowed: false,
            message: "Workspace is borrowed by an open TUI client.",
          },
        },
        en,
      ),
    ).toEqual({
      connectionLabel: "Spark daemon connected",
      borrowedLabel: "In use by 1 terminal session",
      executorLabel: "Running · 2 active invocations · 3 active agents",
      controlLabel:
        "A terminal session is using this workspace. Close or release it before running actions from Cockpit.",
    });
  });

  it("renders disconnected, not borrowed, none, starting, and unhealthy executor states", () => {
    expect(
      workspaceControlDisplay(
        {
          connection: { status: "disconnected", lastSeenAt: "2026-05-22T00:00:00.000Z" },
          borrowed: { borrowed: false, interactiveClientCount: 0 },
          executor: { state: "none", activeInvocationCount: 0, activeAgentCount: 0 },
          control: { mode: "snapshot_only", serverMutationAllowed: false },
        },
        en,
      ),
    ).toMatchObject({
      connectionLabel: "Spark daemon offline",
      borrowedLabel: "Ready for new work",
      executorLabel: "Idle",
      controlLabel: "Read-only for now",
    });
    expect(
      workspaceControlDisplay(
        {
          connection: { status: "connected", lastSeenAt: null },
          executor: { state: "starting", activeInvocationCount: 0, activeAgentCount: 0 },
          control: { mode: "full", serverMutationAllowed: true },
        },
        en,
      ).executorLabel,
    ).toBe("Starting");
    expect(
      workspaceControlDisplay(
        {
          connection: { status: "connected", lastSeenAt: null },
          executor: {
            state: "unhealthy",
            activeInvocationCount: 1,
            activeAgentCount: 1,
            unhealthyReason: "heartbeat missed",
          },
          control: { mode: "snapshot_only", serverMutationAllowed: false },
        },
        en,
      ).executorLabel,
    ).toBe("Execution issue: heartbeat missed");
  });

  it("renders workspace control labels from the Chinese dictionary", () => {
    const display = workspaceControlDisplay(
      {
        connection: { status: "connected", lastSeenAt: null },
        borrowed: { borrowed: false, interactiveClientCount: 0 },
        executor: { state: "none", activeInvocationCount: 0, activeAgentCount: 0 },
        control: { mode: "full", serverMutationAllowed: true },
      },
      zhCN,
    );

    expect(display).toMatchObject({
      connectionLabel: "Spark daemon 已连接",
      borrowedLabel: "可以开始新工作",
      executorLabel: "当前空闲",
      controlLabel: "可以远程执行",
    });
    expect(
      workspaceControlControlLabel(
        { mode: "snapshot_only", reason: "daemon_disconnected", serverMutationAllowed: false },
        zhCN,
      ),
    ).toBe("Spark daemon 当前离线。重新连接后，才可从 Cockpit 执行操作。");
  });
});
