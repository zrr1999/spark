import { describe, expect, it } from "vitest";
import { createNaviaResourceLoader } from "./resource-loader.js";
import { extractFinalAssistantText, extractTextDelta } from "./session.js";

describe("Spark daemon session compatibility surface", () => {
  it("uses a daemon-owned resource loader with no extension discovery by default", () => {
    const loader = createNaviaResourceLoader();

    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getSystemPrompt()).toContain("Spark Daemon");
  });

  it("loads Spark headless session execution through spark-host", async () => {
    const { loadSparkHeadlessSessionModule } =
      await import("@zendev-lab/spark-host/headless-loader");
    const headless = await loadSparkHeadlessSessionModule({
      importModule: async () => ({
        createSparkHeadlessSessionExecutor: () => async () => ({ sessionId: "test" }),
      }),
    });

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

  it("extracts final assistant text from completed Spark headless events", () => {
    expect(
      extractFinalAssistantText({
        type: "stream_event",
        event: {
          type: "done",
          message: { role: "assistant", content: [{ type: "text", text: "final" }] },
        },
      }),
    ).toBe("final");
    expect(
      extractFinalAssistantText({
        type: "turn_complete",
        message: { role: "assistant", content: "turn final" },
      }),
    ).toBe("turn final");
  });
});
