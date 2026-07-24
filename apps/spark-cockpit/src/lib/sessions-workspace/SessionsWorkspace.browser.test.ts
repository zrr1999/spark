import { describe, expect, it } from "vitest";
import { connectionLabel } from "./presentation";

// A clean Linux CI runner must optimize this complete dependency graph before
// Chromium can import it; keep the larger budget local to this smoke.
const coldGraphImportTimeoutMs = 30_000;

describe("SessionsWorkspace browser smoke", () => {
  it(
    "loads the complete conversation pane graph in Chromium",
    async () => {
      const module = await import("./SessionConversationPane.svelte");

      expect(module.default).toBeTypeOf("function");
    },
    coldGraphImportTimeoutMs,
  );

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
