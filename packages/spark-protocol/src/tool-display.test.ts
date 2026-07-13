import { describe, expect, it } from "vitest";
import { summarizeToolCallArguments, summarizeToolResultContent } from "./tool-display.ts";

describe("tool display summaries", () => {
  it("summarizes preferred argument keys and skips sensitive ones", () => {
    expect(
      summarizeToolCallArguments({
        path: "README.md",
        token: "secret-token",
        command: "pnpm test",
        nested: { ignored: true },
      }),
    ).toBe("path=README.md command=pnpm test nested={…}");
  });

  it("summarizes tool result text content with a bound", () => {
    expect(summarizeToolResultContent([{ type: "text", text: "hello from tool" }])).toBe(
      "hello from tool",
    );
    expect(
      summarizeToolResultContent({
        content: [{ type: "text", text: "x".repeat(3000) }],
      })?.endsWith("…"),
    ).toBe(true);
  });
});
