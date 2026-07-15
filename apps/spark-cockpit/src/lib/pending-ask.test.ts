import { describe, expect, it } from "vitest";
import {
  parseHumanQuestions,
  parsePendingAskEvent,
  pendingAskEventCursor,
  shouldInvalidatePendingAsk,
} from "./pending-ask";

describe("pending ask helpers", () => {
  it("normalizes supported question forms without trusting malformed database JSON", () => {
    expect(
      parseHumanQuestions(
        JSON.stringify([
          {
            id: "scope",
            type: "single",
            prompt: "Scope?",
            required: true,
            options: [
              { id: "mvp", label: "MVP", description: "Smallest useful scope" },
              { id: 42, label: "Invalid" },
            ],
          },
          { id: "notes", type: "freeform", prompt: "Anything else?" },
          { id: "invalid", type: "unknown", prompt: "Ignore me" },
        ]),
      ),
    ).toEqual([
      {
        id: "scope",
        type: "single",
        prompt: "Scope?",
        required: true,
        options: [{ id: "mvp", label: "MVP", description: "Smallest useful scope" }],
      },
      { id: "notes", type: "freeform", prompt: "Anything else?" },
    ]);
    expect(parseHumanQuestions("not-json")).toEqual([]);
  });

  it("uses SSE events only to invalidate the active workspace projection", () => {
    const event = parsePendingAskEvent(
      JSON.stringify({
        id: "evt_1",
        workspaceId: "ws_active",
        kind: "human.request.created",
        createdAt: "2026-07-14T00:00:00.000Z",
        payload: { prompt: "must not become UI state" },
      }),
    );

    expect(event).toEqual({
      id: "evt_1",
      workspaceId: "ws_active",
      kind: "human.request.created",
      createdAt: "2026-07-14T00:00:00.000Z",
    });
    expect(event && shouldInvalidatePendingAsk(event, "ws_active")).toBe(true);
    expect(event && shouldInvalidatePendingAsk(event, "ws_other")).toBe(false);
    expect(event && pendingAskEventCursor(event)).toBe("2026-07-14T00:00:00.000Z|evt_1");
    expect(
      shouldInvalidatePendingAsk(
        {
          id: "evt_2",
          workspaceId: "ws_active",
          kind: "human.response.acked",
          createdAt: "2026-07-14T00:00:01.000Z",
        },
        "ws_active",
      ),
    ).toBe(true);
    expect(parsePendingAskEvent("not-json")).toBeNull();
  });
});
