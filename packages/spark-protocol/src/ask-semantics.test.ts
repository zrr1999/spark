import { describe, expect, it } from "vitest";
import { hasSparkAskAnswerContent, parseSparkAskChoice, projectInboxItemStatus } from "./index.ts";

describe("ask semantics", () => {
  it("parses option and custom choices consistently", () => {
    const options = [
      { value: "mvp", label: "MVP" },
      { value: "full", label: "Full" },
    ];
    expect(parseSparkAskChoice(options, "mvp", "single")).toEqual({
      kind: "option",
      values: ["mvp"],
      labels: ["MVP"],
      preview: undefined,
    });
    expect(parseSparkAskChoice(options, "custom note", "single")).toEqual({
      kind: "custom",
      values: [],
      labels: [],
      customText: "custom note",
    });
    expect(hasSparkAskAnswerContent({ values: ["mvp"] })).toBe(true);
    expect(hasSparkAskAnswerContent({ values: [], customText: "  " })).toBe(false);
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
