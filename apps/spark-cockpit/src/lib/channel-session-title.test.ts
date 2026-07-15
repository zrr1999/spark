import { describe, expect, it } from "vitest";
import {
  channelSessionPresentation,
  channelSessionScopeKind,
  formatChannelSessionTitle,
  sessionHasChannelBinding,
  shortenOpaqueChannelId,
} from "./channel-session-title";

describe("channelSessionScopeKind", () => {
  it.each([
    ["infoflow", "user", "private"],
    ["qqbot", "c2c", "private"],
    ["infoflow", "group", "group"],
    ["qqbot", "group", "group"],
    ["qqbot", "channel", "channel"],
    ["feishu", "chat", "conversation"],
  ] as const)("maps %s:%s to %s", (adapter, scope, expected) => {
    expect(channelSessionScopeKind(adapter, scope)).toBe(expected);
  });

  it("keeps invalid adapter/scope combinations visually neutral", () => {
    expect(channelSessionScopeKind("infoflow", "channel")).toBe("conversation");
    expect(channelSessionScopeKind("feishu", "group")).toBe("conversation");
  });
});

describe("formatChannelSessionTitle", () => {
  it("formats Infoflow titles like the session rail", () => {
    expect(
      formatChannelSessionTitle("channel infoflow:user:zhanrongrui", {
        locale: "zh-CN",
        fallback: "未命名",
      }),
    ).toBe("如流私聊 · zhanrongrui");
    expect(
      formatChannelSessionTitle("channel infoflow:group:10838226", {
        locale: "en",
        fallback: "Untitled",
      }),
    ).toBe("Infoflow group · 10838226");
  });

  it("formats QQ Bot titles instead of raw external keys", () => {
    expect(
      formatChannelSessionTitle("channel qqbot:c2c:398418FB5E7F1C597DFFD117597D6500", {
        locale: "zh-CN",
        fallback: "未命名",
      }),
    ).toBe("QQ 私聊 · 398418FB…");
    expect(
      formatChannelSessionTitle("channel qqbot:c2c:Alice", {
        locale: "zh-CN",
        fallback: "未命名",
      }),
    ).toBe("QQ 私聊 · Alice");
    expect(
      formatChannelSessionTitle("channel qqbot:group:g1", {
        locale: "en",
        fallback: "Untitled",
      }),
    ).toBe("QQ group · g1");
  });

  it("returns the fallback for empty titles", () => {
    expect(formatChannelSessionTitle("", { fallback: "Untitled" })).toBe("Untitled");
  });
});

describe("channelSessionPresentation", () => {
  it("uses adapter and scope metadata for an icon while keeping only the compact id as title", () => {
    expect(
      channelSessionPresentation(
        {
          title: "channel qqbot:c2c:398418FB5E7F1C597DFFD117597D6500",
          bindings: [
            {
              kind: "channel",
              adapter: "qqbot",
              externalKey: "qqbot:c2c:398418FB5E7F1C597DFFD117597D6500",
            },
          ],
        },
        { locale: "zh-CN", fallback: "未命名" },
      ),
    ).toEqual({
      title: "398418FB…",
      channel: {
        adapter: "qqbot",
        scope: "c2c",
        externalId: "398418FB5E7F1C597DFFD117597D6500",
        label: "QQ 私聊",
      },
    });
  });

  it("keeps custom channel titles and derives identity from the binding", () => {
    expect(
      channelSessionPresentation(
        {
          title: "运维飞书群",
          bindings: [{ kind: "channel", adapter: "feishu", externalKey: "feishu:chat:oc_ops" }],
        },
        { locale: "zh-CN", fallback: "未命名" },
      ),
    ).toMatchObject({
      title: "运维飞书群",
      channel: { adapter: "feishu", scope: "chat", label: "飞书会话" },
    });
  });

  it("leaves ordinary conversation titles unchanged", () => {
    expect(
      channelSessionPresentation(
        { title: "修复登录问题", bindings: [] },
        { locale: "zh-CN", fallback: "未命名" },
      ),
    ).toEqual({ title: "修复登录问题", channel: null });
  });
});

describe("sessionHasChannelBinding", () => {
  it("detects channel bindings and channel titles", () => {
    expect(
      sessionHasChannelBinding({
        bindings: [{ kind: "channel" }],
        title: "Ops",
      }),
    ).toBe(true);
    expect(
      sessionHasChannelBinding({
        bindings: [],
        title: "channel infoflow:user:alice",
      }),
    ).toBe(true);
    expect(sessionHasChannelBinding({ bindings: [], title: "Local chat" })).toBe(false);
  });
});

describe("shortenOpaqueChannelId", () => {
  it("shortens long hex openids only", () => {
    expect(shortenOpaqueChannelId("398418FB5E7F1C597DFFD117597D6500")).toBe("398418FB…");
    expect(shortenOpaqueChannelId("zhanrongrui")).toBe("zhanrongrui");
  });
});
