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
      submit: vi.fn(async () => ({
        invocationId: "inv_001",
        status: "queued",
        acceptedAt: "2026-07-14T00:00:00.000Z",
      })),
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
    ).resolves.toEqual({ turnId: "inv_001" });

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
      messageMetadata: {
        origin: { kind: "user", host: "web", surface: "local" },
      },
    });
  });

  it("forwards a browser submission nonce as a stable daemon idempotency key", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_nonce",
      status: "queued",
      acceptedAt: "2026-07-15T00:00:00.000Z",
    });

    await submitConversationTurnForCockpit(
      {
        workspaceId: "ws_demo",
        sessionId: "sess_demo",
        prompt: "Run once",
        title: "Run once",
        submissionId: "submit_018f",
      },
      { submit },
    );

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_demo",
        prompt: "Run once",
        idempotencyKey: expect.stringMatching(/^idem_[a-f0-9]{32}$/),
      }),
    );
  });

  it("submits daemon-global messages without inventing a workspace target", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_global",
      status: "queued",
      acceptedAt: "2026-07-14T00:00:00.000Z",
    });

    await expect(
      submitConversationTurnForCockpit(
        {
          sessionId: "sess_global",
          prompt: "Inspect daemon health",
          title: "Inspect daemon health",
        },
        { submit },
      ),
    ).resolves.toEqual({ turnId: "inv_global" });

    expect(submit).toHaveBeenCalledWith({
      sessionId: "sess_global",
      prompt: "Inspect daemon health",
      assignment: expect.objectContaining({
        target: { sessionId: "sess_global" },
      }),
      messageMetadata: {
        origin: { kind: "user", host: "web", surface: "local" },
      },
    });
  });

  it("reuses the browser submission identity across repeated action delivery", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_stable",
      status: "queued",
      acceptedAt: "2026-07-14T00:00:00.000Z",
    });
    const input = {
      sessionId: "sess_stable",
      prompt: "Retry this exact message",
      title: "Retry this exact message",
      submissionId: "browser-submission-1",
    };

    await submitConversationTurnForCockpit(input, { submit });
    await submitConversationTurnForCockpit(input, { submit });

    const firstKey = submit.mock.calls[0]?.[0].idempotencyKey;
    expect(firstKey).toMatch(/^idem_[a-f0-9]{32}$/);
    expect(submit.mock.calls[1]?.[0].idempotencyKey).toBe(firstKey);
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
        invocationId: "inv_001",
        status: "running",
        cancelRequested: true,
      })),
    } satisfies CockpitConversationCancelClient;

    await expect(
      cancelConversationTurnForCockpit(
        {
          sessionId: "  sess_001  ",
          turnId: "  inv_001  ",
          reason: "  Stopped from Cockpit.  ",
        },
        client,
      ),
    ).resolves.toEqual({
      turnId: "inv_001",
      status: "running",
      cancelRequested: true,
    });

    expect(client.cancel).toHaveBeenCalledWith({
      sessionId: "sess_001",
      invocationId: "inv_001",
      reason: "Stopped from Cockpit.",
    });
  });

  it("omits an empty cancellation reason", async () => {
    const cancel = vi.fn(async () => ({
      invocationId: "inv_missing",
      status: "cancelled",
      cancelRequested: false,
    }));

    await expect(
      cancelConversationTurnForCockpit(
        { sessionId: "sess_001", turnId: "inv_missing", reason: "   " },
        { cancel },
      ),
    ).resolves.toEqual({
      turnId: "inv_missing",
      status: "cancelled",
      cancelRequested: false,
    });

    expect(cancel).toHaveBeenCalledWith({
      sessionId: "sess_001",
      invocationId: "inv_missing",
    });
  });

  it.each([
    null,
    {},
    { invocationId: "inv_001", status: "running", cancelRequested: "yes" },
    { invocationId: "not-an-invocation", status: "running", cancelRequested: true },
    { invocationId: "inv_001", status: "unknown", cancelRequested: true },
  ])("rejects malformed daemon cancellation receipts: %j", async (receipt) => {
    await expect(
      cancelConversationTurnForCockpit(
        { sessionId: "sess_001", turnId: "inv_001" },
        { cancel: async () => receipt },
      ),
    ).rejects.toThrow("invalid conversation turn cancellation receipt");
  });

  it("requires both the owning session and turn id before calling the daemon", async () => {
    const cancel = vi.fn();

    await expect(
      cancelConversationTurnForCockpit({ sessionId: "   ", turnId: "inv_001" }, { cancel }),
    ).rejects.toThrow("Select a conversation");
    await expect(
      cancelConversationTurnForCockpit({ sessionId: "sess_001", turnId: "   " }, { cancel }),
    ).rejects.toThrow("Select a queued or active conversation turn");
    expect(cancel).not.toHaveBeenCalled();
  });
});
