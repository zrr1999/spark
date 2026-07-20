import { describe, expect, it } from "vitest";
import {
  initialSessionEventConnectionState,
  openingSessionEventConnectionState,
} from "./session-event-connection";

describe("session event connection display", () => {
  it("starts an already-rendered session in the stable live state", () => {
    expect(initialSessionEventConnectionState("sess_demo")).toBe("live");
    expect(initialSessionEventConnectionState(null)).toBe("offline");
  });

  it("does not flash connecting while switching or retrying a session stream", () => {
    expect(openingSessionEventConnectionState("live")).toBe("live");
    expect(openingSessionEventConnectionState("reconnecting")).toBe("reconnecting");
    expect(openingSessionEventConnectionState("offline")).toBe("connecting");
    expect(openingSessionEventConnectionState("connecting")).toBe("connecting");
  });
});
