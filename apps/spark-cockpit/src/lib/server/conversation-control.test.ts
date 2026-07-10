import { describe, expect, it, vi } from "vitest";
import {
  submitConversationTurnForCockpit,
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
});
