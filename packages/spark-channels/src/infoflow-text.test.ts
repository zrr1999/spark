import { describe, expect, it } from "vitest";
import { INFOFLOW_MAX_CARD_TEXT_LENGTH, chunkInfoflowText } from "./infoflow-text.ts";

describe("chunkInfoflowText", () => {
  it("keeps short Chinese markdown as one chunk", () => {
    expect(chunkInfoflowText("你好，**世界**")).toEqual(["你好，**世界**"]);
  });

  it("splits long Chinese text on the character budget", () => {
    const source = `${"甲".repeat(4_000)}\n\n${"乙".repeat(4_000)}`;
    const chunks = chunkInfoflowText(source, 5_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 5_000)).toBe(true);
    expect(chunks.join("\n\n")).toBe(source);
  });

  it("prefers breaking before an open markdown emphasis marker", () => {
    const prefix = "前".repeat(90);
    const source = `${prefix}**本段加粗未闭合且继续`;
    const chunks = chunkInfoflowText(source, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith("前")).toBe(true);
    expect(chunks.slice(1).join("")).toContain("**本");
  });

  it("uses the Infoflow card budget by default", () => {
    const source = "字".repeat(INFOFLOW_MAX_CARD_TEXT_LENGTH + 10);
    const chunks = chunkInfoflowText(source);
    expect(chunks[0]?.length).toBeLessThanOrEqual(INFOFLOW_MAX_CARD_TEXT_LENGTH);
    expect(chunks.join("")).toBe(source);
  });
});
