import { describe, expect, it } from "vitest";
import { cancelledTurnIdFromActionResult } from "./session-action-result";

describe("session action results", () => {
  it("reads the cancelled turn id from the server result instead of live UI state", () => {
    expect(
      cancelledTurnIdFromActionResult({
        type: "success",
        data: { cancelledTurnId: "  turn_cancelled.json  " },
      }),
    ).toBe("turn_cancelled.json");
  });

  it.each([
    null,
    {},
    { cancelledTurnId: "turn_top_level.json" },
    { data: null },
    { data: {} },
    { data: { cancelledTurnId: "   " } },
  ])("rejects a missing or malformed server cancellation id: %j", (result) => {
    expect(cancelledTurnIdFromActionResult(result)).toBeNull();
  });
});
