import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const componentPath = join(root, "AskQuestionField.svelte");

describe("AskQuestionField", () => {
  it("compiles as a shared Global Ask and Inbox question field", () => {
    const source = readFileSync(componentPath, "utf8");
    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("always adds a custom reply to single, preview, and multi choice questions", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('question.type === "single"');
    expect(source).toContain('question.type === "multi"');
    expect(source).toContain('question.type === "preview"');
    expect(source).toContain(
      '(question.type === "single" || question.type === "preview") && question.options?.length',
    );
    expect(source.match(/value=\{cockpitCustomAnswerValue\}/gu)).toHaveLength(2);
    expect(source.match(/name=\{customAnswerName\}/gu)).toHaveLength(2);
    expect(source).toContain("selectCustomChoice");
    expect(source).toContain("choice.click()");
    expect(source.match(/option\.preview/gu)).toHaveLength(4);
    expect(source.match(/class="option-preview"/gu)).toHaveLength(2);
    expect(source).toContain('type="radio"');
    expect(source).toContain("required={question.required}");
    expect(source).not.toContain('type="checkbox" value={option.value} required');
    expect(source).not.toContain("messages.previewOnly");
    expect(source).not.toContain("allowOther");
  });
});
