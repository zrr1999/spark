import { describe, expect, it } from "vitest";
import { createNaviaResourceLoader } from "./resource-loader.js";
import { extractTextDelta } from "./session.js";

describe("Spark daemon session compatibility surface", () => {
  it("uses a daemon-owned resource loader with no extension discovery by default", () => {
    const loader = createNaviaResourceLoader();

    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getSystemPrompt()).toContain("Spark Daemon");
  });

  it("uses Spark headless session execution instead of pi-coding-agent sessions", async () => {
    const headless = await import("@zendev-lab/spark-tui-app/headless-role-executor");

    expect(typeof headless.createSparkHeadlessSessionExecutor).toBe("function");
  });

  it("extracts text deltas from Spark headless stream events and legacy Pi events", () => {
    expect(
      extractTextDelta({ type: "stream_event", event: { type: "text_delta", delta: "spark" } }),
    ).toBe("spark");
    expect(
      extractTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "legacy" },
      }),
    ).toBe("legacy");
    expect(extractTextDelta({ type: "stream_event", event: { type: "done" } })).toBeNull();
  });
});
