import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "Message.svelte");
const actionsPath = resolve(dirname(fileURLToPath(import.meta.url)), "MessageActions.svelte");

describe("Message component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("keeps process-only rows visible while excluding process detail from copy", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("visibleConversationParts(item.parts)");
    expect(source).toContain("visibleConversationPartText(item.parts)");
    expect(source).toContain("{#if visibleParts.length > 0}");
    expect(source).not.toContain("hidden={visibleParts.length === 0}");
    expect(source).toContain("{#each visibleParts as part");
    expect(source).toContain("<MessageActions text={copyableText}");
    expect(source).not.toContain("<MessageActions text={item.body}");
    expect(source).toContain("{active}");
  });

  it("renders retry only when the owning workspace marks this message as retryable", () => {
    const messageSource = readFileSync(componentPath, "utf8");

    expect(messageSource).toContain("{#if retryAction}");
    expect(messageSource).toContain("<SessionRetryAction {...retryAction} />");
    expect(messageSource).not.toContain("retryPrompt={item.retryPrompt}");
  });

  it("uses the compact source-derived message action instead of visible copy text", () => {
    const source = readFileSync(actionsPath, "utf8");

    expect(source).toContain("aria-label={copied ? copiedLabel : copyLabel}");
    expect(source).toContain('<span class="sr-only">');
    expect(source).toContain("@media (hover: hover)");
    expect(source).toContain(":global(.conversation-message:hover) .message-actions");
  });
});
