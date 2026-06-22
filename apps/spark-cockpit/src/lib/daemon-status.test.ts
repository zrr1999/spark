import { describe, expect, it } from "vitest";
import { daemonDisplayStatus } from "./daemon-status";

describe("daemon display status", () => {
  it("shows a never-connected offline daemon as registered", () => {
    expect(daemonDisplayStatus({ status: "offline", lastHeartbeatAt: null })).toBe("registered");
  });

  it("keeps a previously connected offline daemon offline", () => {
    expect(
      daemonDisplayStatus({
        status: "offline",
        lastHeartbeatAt: "2026-05-25T00:00:00.000Z",
      }),
    ).toBe("offline");
  });

  it("keeps live connection states unchanged", () => {
    expect(daemonDisplayStatus({ status: "online", lastHeartbeatAt: null })).toBe("online");
    expect(daemonDisplayStatus({ status: "draining", lastHeartbeatAt: null })).toBe("draining");
    expect(daemonDisplayStatus({ status: "disabled", lastHeartbeatAt: null })).toBe("disabled");
  });
});
