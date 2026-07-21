import { describe, expect, it } from "vitest";
import { summarizeToolCallArguments, summarizeToolResultContent } from "./tool-display.ts";

describe("tool display summaries", () => {
  it("summarizes preferred argument keys and skips sensitive ones", () => {
    expect(
      summarizeToolCallArguments({
        path: "README.md",
        token: "secret-token",
        api_key: "hidden",
        command: "pnpm test",
        nested: { ignored: true },
        flag: true,
        count: 3,
        empty: "   ",
        tags: ["a", "b"],
        none: null,
      }),
    ).toBe("path=README.md command=pnpm test nested={…} flag=true count=3 tags=a,b none=null");
  });

  it("returns undefined for non-objects and empty summaries", () => {
    expect(summarizeToolCallArguments(undefined)).toBeUndefined();
    expect(summarizeToolCallArguments("x")).toBeUndefined();
    expect(summarizeToolCallArguments([])).toBeUndefined();
    expect(summarizeToolCallArguments({ token: "secret" })).toBeUndefined();
  });

  it("bounds argument summaries and long scalar values", () => {
    expect(summarizeToolCallArguments({ path: "x".repeat(100) })).toMatch(/path=x{77}…$/u);
    expect(summarizeToolCallArguments({ items: Array.from({ length: 40 }, (_, i) => i) })).toMatch(
      /^items=\d/u,
    );
    expect(
      summarizeToolCallArguments({ items: Array.from({ length: 40 }, (_, i) => i) })?.endsWith("…"),
    ).toBe(true);
    expect(summarizeToolCallArguments({ items: [{}, {}] })).toBe("items=[2]");
    expect(summarizeToolCallArguments({ items: [] })).toBe("items=[]");
    expect(
      summarizeToolCallArguments(
        { path: "a", command: "b", name: "c", title: "d", status: "e", mode: "f" },
        20,
      ),
    ).toMatch(/…$/u);
  });

  it("summarizes tool result text content with a bound", () => {
    expect(summarizeToolResultContent("  plain  ")).toBe("plain");
    expect(summarizeToolResultContent([{ type: "text", text: "hello from tool" }])).toBe(
      "hello from tool",
    );
    expect(summarizeToolResultContent({ text: "  via text  " })).toBe("via text");
    expect(summarizeToolResultContent({ message: "via message" })).toBe("via message");
    expect(summarizeToolResultContent({ error: "via error" })).toBe("via error");
    expect(
      summarizeToolResultContent({
        content: [{ type: "text", text: "x".repeat(3000) }],
      })?.endsWith("…"),
    ).toBe(true);
    expect(summarizeToolResultContent({ content: [{ type: "image" }] })).toBeUndefined();
    expect(summarizeToolResultContent(null)).toBeUndefined();
  });
});
