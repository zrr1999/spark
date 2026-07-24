import { describe, expect, it } from "vitest";
import { connectionLabel } from "./presentation";

describe("SessionsWorkspace browser smoke", () => {
  it("loads the complete conversation pane graph in Chromium", async () => {
    const module = await import("./SessionConversationPane.svelte");

    expect(module.default).toBeTypeOf("function");
  });

  it("exposes connection label helpers used by the stage header", () => {
    expect(
      connectionLabel("live", {
        live: "Connected",
        connecting: "Connecting",
        reconnecting: "Reconnecting",
        offline: "Offline",
      }),
    ).toBe("Connected");
  });
});
