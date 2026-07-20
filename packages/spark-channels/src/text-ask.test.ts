import { describe, expect, it } from "vitest";
import { renderTextChannelAsk, renderTextChannelAskRequest } from "./text-ask.ts";

describe("text channel ask renderer", () => {
  it("renders numbered options for digit replies", () => {
    expect(
      renderTextChannelAsk({
        title: "Choose a route",
        prompt: "Which route?",
        options: [{ label: "Fast", description: "Prefer latency." }, { label: "Safe" }],
      }),
    ).toBe(
      [
        "## Choose a route",
        "",
        "Which route?",
        "",
        "请回复序号或直接输入：",
        "1. Fast — Prefer latency.",
        "2. Safe",
      ].join("\n"),
    );
  });

  it("renders a freeform prompt without options", () => {
    expect(
      renderTextChannelAsk({
        title: "Need more detail",
        prompt: "What should we call this?",
      }),
    ).toBe(
      ["## Need more detail", "", "What should we call this?", "", "请直接回复你的答案。"].join(
        "\n",
      ),
    );
  });

  it("prefers an already-rendered ChannelAskRequest prompt", () => {
    expect(
      renderTextChannelAskRequest({
        prompt: "## Ready\n\nContinue?\n\n请回复序号或直接输入：\n1. Yes",
        options: [{ id: "1", label: "Yes", data: "opaque" }],
      }),
    ).toBe("## Ready\n\nContinue?\n\n请回复序号或直接输入：\n1. Yes");
  });
});
