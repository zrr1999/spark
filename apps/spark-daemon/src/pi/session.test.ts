import { describe, expect, it } from "vitest";
import { createNaviaResourceLoader } from "./resource-loader.js";

describe("Pi SDK integration surface", () => {
  it("uses a daemon-owned resource loader with no extension discovery by default", () => {
    const loader = createNaviaResourceLoader();

    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getSystemPrompt()).toContain("Spark Daemon");
  });

  it("can import the pinned Pi SDK", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");

    expect(typeof sdk.createAgentSession).toBe("function");
    expect(typeof sdk.AuthStorage.create).toBe("function");
  });
});
