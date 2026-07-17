import { describe, expect, it } from "vitest";
import {
  cancelledTurnIdFromActionResult,
  queuedTurnIdFromActionResult,
} from "./session-action-result";

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

  it("reads only a nested successful send receipt", () => {
    expect(
      queuedTurnIdFromActionResult({
        type: "success",
        data: { queuedTurnId: "  inv_direct  " },
      }),
    ).toBe("inv_direct");
    expect(queuedTurnIdFromActionResult({ queuedTurnId: "inv_top_level" })).toBeNull();
    expect(queuedTurnIdFromActionResult({ data: { queuedTurnId: "   " } })).toBeNull();
  });
});
