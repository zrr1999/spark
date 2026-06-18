import { describe, expect, it } from "vitest";
import { runnerDisplayStatus } from "./runner-status";

describe("runner display status", () => {
  it("shows a never-connected offline runner as registered", () => {
    expect(runnerDisplayStatus({ status: "offline", lastHeartbeatAt: null })).toBe("registered");
  });

  it("keeps a previously connected offline runner offline", () => {
    expect(
      runnerDisplayStatus({
        status: "offline",
        lastHeartbeatAt: "2026-05-25T00:00:00.000Z",
      }),
    ).toBe("offline");
  });

  it("keeps live connection states unchanged", () => {
    expect(runnerDisplayStatus({ status: "online", lastHeartbeatAt: null })).toBe("online");
    expect(runnerDisplayStatus({ status: "draining", lastHeartbeatAt: null })).toBe("draining");
    expect(runnerDisplayStatus({ status: "disabled", lastHeartbeatAt: null })).toBe("disabled");
  });
});
