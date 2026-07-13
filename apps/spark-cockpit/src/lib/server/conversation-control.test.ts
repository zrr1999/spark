import { describe, expect, it, vi } from "vitest";
import {
  cancelConversationTurnForCockpit,
  submitConversationTurnForCockpit,
  type CockpitConversationCancelClient,
  type CockpitConversationControlClient,
} from "./conversation-control";

describe("Cockpit conversation control", () => {
  it("submits Web messages through the daemon-owned turn surface", async () => {
    const client = {
      submit: vi.fn(async () => ({ fileName: "turn_001" })),
    } satisfies CockpitConversationControlClient;

    await expect(
      submitConversationTurnForCockpit(
        {
          workspaceId: "ws_demo",
          sessionId: "sess_demo",
          prompt: "Continue the same conversation.",
          title: "Continue the same conversation.",
        },
        client,
      ),
    ).resolves.toEqual({ turnId: "turn_001" });

    expect(client.submit).toHaveBeenCalledWith({
      sessionId: "sess_demo",
      prompt: "Continue the same conversation.",
      assignment: {
        goal: "Continue the same conversation.",
        title: "Continue the same conversation.",
        target: { sessionId: "sess_demo", workspaceId: "ws_demo" },
        constraints: [],
        evidence: [],
        source: { kind: "cockpit" },
      },
    });
  });

  it("submits daemon-global messages without inventing a workspace target", async () => {
    const submit = vi.fn().mockResolvedValue({ fileName: "turn-global.json" });

    await expect(
      submitConversationTurnForCockpit(
        {
          sessionId: "sess_global",
          prompt: "Inspect daemon health",
          title: "Inspect daemon health",
        },
        { submit },
      ),
    ).resolves.toEqual({ turnId: "turn-global.json" });

    expect(submit).toHaveBeenCalledWith({
      sessionId: "sess_global",
      prompt: "Inspect daemon health",
      assignment: expect.objectContaining({
        target: { sessionId: "sess_global" },
      }),
    });
  });

  it("rejects malformed daemon receipts", async () => {
    const client = {
      submit: vi.fn(async () => ({})),
    } satisfies CockpitConversationControlClient;

    await expect(
      submitConversationTurnForCockpit(
        {
          workspaceId: "ws_demo",
          sessionId: "sess_demo",
          prompt: "Hello",
          title: "Hello",
        },
        client,
      ),
    ).rejects.toThrow("invalid conversation turn receipt");
  });

  it("cancels a queued or active daemon turn within its submitted session", async () => {
    const client = {
      cancel: vi.fn(async () => ({
        invocationId: "turn_001.json",
        cancelled: true,
        outcome: "cancel-requested",
        message: "Cancellation requested.",
      })),
    } satisfies CockpitConversationCancelClient;

    await expect(
      cancelConversationTurnForCockpit(
        {
          sessionId: "  sess_001  ",
          turnId: "  turn_001.json  ",
          reason: "  Stopped from Cockpit.  ",
        },
        client,
      ),
    ).resolves.toEqual({
      turnId: "turn_001.json",
      cancelled: true,
      outcome: "cancel-requested",
      message: "Cancellation requested.",
    });

    expect(client.cancel).toHaveBeenCalledWith({
      invocationId: "turn_001.json",
      sessionId: "sess_001",
      reason: "Stopped from Cockpit.",
    });
  });

  it("omits an empty cancellation reason", async () => {
    const cancel = vi.fn(async () => ({
      cancelled: false,
      outcome: "not-found",
      message: "No queued or active invocation matched.",
    }));

    await expect(
      cancelConversationTurnForCockpit(
        { sessionId: "sess_001", turnId: "turn_missing", reason: "   " },
        { cancel },
      ),
    ).resolves.toEqual({
      turnId: "turn_missing",
      cancelled: false,
      outcome: "not-found",
      message: "No queued or active invocation matched.",
    });

    expect(cancel).toHaveBeenCalledWith({
      invocationId: "turn_missing",
      sessionId: "sess_001",
    });
  });

  it.each([
    null,
    {},
    { cancelled: "yes", outcome: "cancel-requested", message: "Cancellation requested." },
    { cancelled: true, outcome: "cancel-requested" },
    { cancelled: true, outcome: "cancel-requested", message: "   " },
    { cancelled: true, outcome: "unknown", message: "Cancellation requested." },
    { cancelled: true, outcome: "not-found", message: "No invocation matched." },
  ])("rejects malformed daemon cancellation receipts: %j", async (receipt) => {
    await expect(
      cancelConversationTurnForCockpit(
        { sessionId: "sess_001", turnId: "turn_001" },
        { cancel: async () => receipt },
      ),
    ).rejects.toThrow("invalid conversation turn cancellation receipt");
  });

  it("requires both the owning session and turn id before calling the daemon", async () => {
    const cancel = vi.fn();

    await expect(
      cancelConversationTurnForCockpit({ sessionId: "   ", turnId: "turn_001" }, { cancel }),
    ).rejects.toThrow("Select a conversation");
    await expect(
      cancelConversationTurnForCockpit({ sessionId: "sess_001", turnId: "   " }, { cancel }),
    ).rejects.toThrow("Select a queued or active conversation turn");
    expect(cancel).not.toHaveBeenCalled();
  });
});
