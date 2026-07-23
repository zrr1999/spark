import { describe, expect, it } from "vitest";
import { connectionLabel } from "./presentation";

describe("SessionsWorkspace browser smoke", () => {
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
