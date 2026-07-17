import { describe, expect, it } from "vitest";
import {
  cockpitCustomAnswerValue,
  humanAskAnswerHasValue,
  humanMultiAnswerWithCustomFallback,
  humanSingleAnswerWithCustomFallback,
  parseHumanQuestions,
  parsePendingAskEvent,
  pendingAskEventCursor,
  shouldInvalidatePendingAsk,
} from "./pending-ask";

describe("pending ask helpers", () => {
  it("encodes option and custom replies in the structured ask answer shape", () => {
    const single = {
      id: "scope",
      type: "single" as const,
      prompt: "Scope?",
      options: [
        { value: "mvp", label: "MVP" },
        { value: "full", label: "Full" },
      ],
    };
    const multi = {
      id: "surface",
      type: "multi" as const,
      prompt: "Surfaces?",
      options: [
        { value: "web", label: "Web" },
        { value: "tui", label: "TUI" },
      ],
    };

    expect(humanSingleAnswerWithCustomFallback(single, "mvp", "ignored")).toEqual({
      values: ["mvp"],
      labels: ["MVP"],
    });
    expect(
      humanSingleAnswerWithCustomFallback(single, cockpitCustomAnswerValue, "  custom  "),
    ).toEqual({ values: [], customText: "custom" });
    expect(
      humanMultiAnswerWithCustomFallback(
        multi,
        ["web", cockpitCustomAnswerValue],
        "  native app  ",
      ),
    ).toEqual({ values: ["web"], labels: ["Web"], customText: "native app" });
    expect(humanMultiAnswerWithCustomFallback(multi, [cockpitCustomAnswerValue], "  ")).toEqual({
      values: [],
    });
    expect(
      humanSingleAnswerWithCustomFallback(
        { id: "notes", type: "freeform", prompt: "Notes?" },
        "  any detail  ",
        "",
      ),
    ).toEqual({ values: [], customText: "any detail" });
    expect(
      humanSingleAnswerWithCustomFallback(
        {
          id: "preview-choice",
          type: "preview",
          prompt: "Choose preview",
          required: true,
          options: [{ value: "compact", label: "Compact preview" }],
        },
        "compact",
        "",
      ),
    ).toEqual({ values: ["compact"], labels: ["Compact preview"] });
    expect(
      humanSingleAnswerWithCustomFallback(
        {
          id: "preview-choice",
          type: "preview",
          prompt: "Choose preview",
          required: true,
          options: [{ value: "compact", label: "Compact preview" }],
        },
        cockpitCustomAnswerValue,
        "  another preview  ",
      ),
    ).toEqual({ values: [], customText: "another preview" });
    expect(
      humanSingleAnswerWithCustomFallback(
        { id: "preview-text", type: "preview", prompt: "Describe preview" },
        "  custom preview  ",
        "",
      ),
    ).toEqual({ values: [], customText: "custom preview" });
    expect(
      humanMultiAnswerWithCustomFallback(
        { id: "multi-text", type: "multi", prompt: "Describe selections" },
        ["  custom multi reply  "],
        "",
      ),
    ).toEqual({ values: [], customText: "custom multi reply" });
    expect(humanAskAnswerHasValue({ values: [], customText: "custom" })).toBe(true);
    expect(humanAskAnswerHasValue({ values: [] })).toBe(false);
  });

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
              {
                value: "mvp",
                label: "MVP",
                description: "Smallest useful scope",
                preview: "src/mvp.ts\n+export const ready = true;",
              },
              { value: 42, label: "Invalid" },
            ],
          },
          {
            id: "legacy",
            type: "single",
            prompt: "Legacy id field?",
            options: [{ id: "keep", label: "Keep" }],
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
        options: [
          {
            value: "mvp",
            label: "MVP",
            description: "Smallest useful scope",
            preview: "src/mvp.ts\n+export const ready = true;",
          },
        ],
      },
      {
        id: "legacy",
        type: "single",
        prompt: "Legacy id field?",
        options: [{ value: "keep", label: "Keep" }],
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
