import { describe, expect, it } from "vitest";
import {
  defaultSparkAskChoice,
  formatSparkAskAnswerForDisplay,
  hasRequiredSparkAskSelections,
  hasSparkAskAnswerContent,
  hasSubmittedRequiredSparkAskAnswers,
  inferSparkAskSubmitStatus,
  nextActionForSparkAskSubmit,
  parseSparkAskChoice,
  projectInboxItemStatus,
  requiresExplicitSparkAskGateSelection,
} from "./index.ts";

describe("ask semantics", () => {
  const options = [
    { value: "mvp", label: "MVP", preview: "ship thin" },
    { value: "full", label: "Full" },
  ];

  it("parses option and custom choices consistently", () => {
    expect(parseSparkAskChoice(options, "mvp", "single")).toEqual({
      kind: "option",
      values: ["mvp"],
      labels: ["MVP"],
      preview: "ship thin",
    });
    expect(parseSparkAskChoice(options, "custom note", "single")).toEqual({
      kind: "custom",
      values: [],
      labels: [],
      customText: "custom note",
    });
    expect(hasSparkAskAnswerContent({ values: ["mvp"] })).toBe(true);
    expect(hasSparkAskAnswerContent({ values: ["  "], customText: "  " })).toBe(false);
    expect(hasSparkAskAnswerContent(undefined)).toBe(false);
  });

  it("parses multi choices with unmatched custom fragments", () => {
    expect(parseSparkAskChoice(options, "MVP, extra, Full", "multi")).toEqual({
      kind: "multi",
      values: ["mvp", "full"],
      labels: ["MVP", "Full"],
      customText: "extra",
    });
    expect(parseSparkAskChoice(options, "  ,  ", "multi")).toEqual({
      kind: "multi",
      values: [],
      labels: [],
    });
  });

  it("defaults and formats ask choices for display", () => {
    expect(defaultSparkAskChoice(options, "single")).toEqual({
      kind: "option",
      values: ["mvp"],
      labels: ["MVP"],
      preview: "ship thin",
    });
    expect(defaultSparkAskChoice(options, "multi")?.kind).toBe("multi");
    expect(defaultSparkAskChoice(options, "freeform")).toEqual({
      kind: "custom",
      values: [],
      labels: [],
      customText: "",
    });
    expect(defaultSparkAskChoice([], "single")).toBeUndefined();
    expect(formatSparkAskAnswerForDisplay({ labels: ["MVP", ""], customText: "ignored" })).toBe(
      "MVP",
    );
    expect(formatSparkAskAnswerForDisplay({ labels: [], customText: "note" })).toBe("note");
  });

  it("gates required ask answers before resume", () => {
    const request = {
      mode: "decision",
      questions: [{ id: "q1", type: "single" as const, required: true }],
    };
    expect(requiresExplicitSparkAskGateSelection("decision", request.questions[0]!)).toBe(true);
    expect(requiresExplicitSparkAskGateSelection("approval", request.questions[0]!)).toBe(true);
    expect(requiresExplicitSparkAskGateSelection("chat", request.questions[0]!)).toBe(false);

    const unanswered = {};
    expect(hasSubmittedRequiredSparkAskAnswers(request, unanswered)).toBe(false);
    expect(inferSparkAskSubmitStatus(request, unanswered)).toBe("no_selection");
    expect(nextActionForSparkAskSubmit(request, unanswered, "answered")).toBe("block");

    const answered = { q1: { values: ["mvp"] } };
    expect(hasSubmittedRequiredSparkAskAnswers(request, answered)).toBe(true);
    expect(hasRequiredSparkAskSelections(request, answered)).toBe(true);
    expect(nextActionForSparkAskSubmit(request, answered, "answered")).toBe("resume");
    expect(nextActionForSparkAskSubmit(request, answered, "cancelled")).toBe("block");

    const optionalOnly = {
      mode: "decision",
      questions: [{ id: "q2", type: "single" as const, required: false }],
    };
    expect(hasSubmittedRequiredSparkAskAnswers(optionalOnly, {})).toBe(false);
    expect(hasSubmittedRequiredSparkAskAnswers(optionalOnly, { q2: { values: ["mvp"] } })).toBe(
      true,
    );

    const freeform = {
      mode: "decision",
      questions: [{ id: "q3", type: "freeform" as const, required: true }],
    };
    expect(
      hasRequiredSparkAskSelections(freeform, { q3: { values: [], customText: "notes" } }),
    ).toBe(true);
    expect(hasRequiredSparkAskSelections(freeform, { q3: { values: ["  "] } })).toBe(false);
  });

  it("keeps multi preview only for a single matched option", () => {
    expect(parseSparkAskChoice(options, "MVP", "multi")).toEqual({
      kind: "multi",
      values: ["mvp"],
      labels: ["MVP"],
      preview: "ship thin",
    });
  });
});

describe("human interaction status projection", () => {
  it("maps daemon wait statuses onto inbox item statuses", () => {
    expect(projectInboxItemStatus("pending")).toBe("pending");
    expect(projectInboxItemStatus("answered")).toBe("resolved");
    expect(projectInboxItemStatus("cancelled")).toBe("resolved");
    expect(projectInboxItemStatus("archived")).toBe("archived");
  });
});
