import { describe, expect, it } from "vitest";
import {
  formatChannelSessionTitle,
  sessionHasChannelBinding,
  shortenOpaqueChannelId,
} from "./channel-session-title";

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
