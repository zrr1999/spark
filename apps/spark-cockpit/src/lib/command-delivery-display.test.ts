import { describe, expect, it } from "vitest";
import {
  commandDeliveryDetail,
  commandDeliveryHeadline,
  type CommandDeliveryDisplayCommand,
  type CommandDeliveryDisplayMessages,
} from "./command-delivery-display";

const messages: CommandDeliveryDisplayMessages = {
  pendingAwaitingHeartbeat: "Queued — waiting for runtime heartbeat",
  pendingOnline: "Pending — sending to runtime",
  pendingOffline: "Pending — waiting for runtime reconnect",
  sent: "Delivered — waiting for ack",
  acked: "Acknowledged",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
  none: "No delivery record",
  notAttempted: "not attempted",
  awaitingHeartbeat: "waiting for next runtime heartbeat",
  attemptSingular: "delivery attempt",
  attemptPlural: "delivery attempts",
  ackedPrefix: "acked",
  sentPrefix: "sent",
};

function command(overrides: Partial<CommandDeliveryDisplayCommand>): CommandDeliveryDisplayCommand {
  return {
    deliveryStatus: null,
    attemptCount: null,
    lastAttemptAt: null,
    ackedAt: null,
    rejectCode: null,
    rejectMessage: null,
    runtimeWorkspaceName: "spore",
    runtimeName: "zhanrongruideMacBook-Pro.local",
    runtimeStatus: "online",
    ...overrides,
  };
}

const relative = (value: string | null) => (value ? `relative(${value})` : "never");

describe("command delivery display", () => {
  it("describes pending zero-attempt commands as waiting for heartbeat, not actively sending", () => {
    const pending = command({ deliveryStatus: "pending", attemptCount: 0 });

    expect(commandDeliveryHeadline(pending, messages)).toBe(
      "Queued — waiting for runtime heartbeat",
    );
    expect(commandDeliveryDetail(pending, messages, relative)).toContain(
      "waiting for next runtime heartbeat",
    );
  });

  it("describes attempted pending commands as active delivery/reconnect state", () => {
    const pending = command({ deliveryStatus: "pending", attemptCount: 2 });

    expect(commandDeliveryHeadline(pending, messages)).toBe("Pending — sending to runtime");
    expect(commandDeliveryDetail(pending, messages, relative)).toContain("2 delivery attempts");
  });

  it("describes sent and acked terminal projection states without falling back to pending", () => {
    const sent = command({
      deliveryStatus: "sent",
      attemptCount: 1,
      lastAttemptAt: "2026-06-30T09:37:38.991Z",
    });
    const acked = command({
      deliveryStatus: "acked",
      attemptCount: 1,
      ackedAt: "2026-06-30T09:37:39.263Z",
    });

    expect(commandDeliveryHeadline(sent, messages)).toBe("Delivered — waiting for ack");
    expect(commandDeliveryDetail(sent, messages, relative)).toContain("sent relative(");
    expect(commandDeliveryHeadline(acked, messages)).toBe("Acknowledged");
    expect(commandDeliveryDetail(acked, messages, relative)).toContain("acked relative(");
  });
});
