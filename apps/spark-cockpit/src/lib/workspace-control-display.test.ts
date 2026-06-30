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
      connectionLabel: "Daemon connected",
      borrowedLabel: "Borrowed by 1 TUI client",
      executorLabel: "Background executor online · 2 active invocations · 3 active agents",
      controlLabel:
        "Workspace is borrowed by an open TUI client; server actions are snapshot-only until it releases the workspace.",
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
      connectionLabel: "Daemon disconnected",
      borrowedLabel: "Workspace not borrowed",
      executorLabel: "No background executor",
      controlLabel: "Snapshot-only mode",
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
    ).toBe("Background executor starting");
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
    ).toBe("Background executor unhealthy: heartbeat missed");
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
      connectionLabel: "Daemon 已连接",
      borrowedLabel: "工作空间未被借用",
      executorLabel: "无后台执行器",
      controlLabel: "服务端控制已启用",
    });
    expect(
      workspaceControlControlLabel(
        { mode: "snapshot_only", reason: "daemon_disconnected", serverMutationAllowed: false },
        zhCN,
      ),
    ).toBe("工作空间 daemon 已断开；重新连接前服务端操作仅使用快照模式。");
  });
});
