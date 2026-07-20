import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRawSnippet } from "svelte";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ConversationViewport from "./ConversationViewport.svelte";

const componentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "ConversationViewport.svelte",
);

describe("ConversationViewport component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("keeps messages separated from the vertical scrollbar", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("padding: 8px max(var(--spacing-sm), calc((100% - 800px) / 2)) 20px;");
    expect(source).toContain("padding-inline: var(--spacing-sm);");
    expect(source).not.toContain("padding-inline: 0;");
  });

  it("loads history near the top while preserving the visible message anchor", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("LOAD_EARLIER_THRESHOLD = 96");
    expect(source).toContain("viewport.scrollTop <= LOAD_EARLIER_THRESHOLD");
    expect(source).toContain("captureConversationPrependAnchor(element)");
    expect(source).toContain("restoreConversationPrependAnchor(element, anchor)");
    expect(source).toContain("suspendFollow = true");
    expect(source).toContain("initialScrollComplete = $state(false)");
    expect(source).toContain("!element || !initialScrollComplete || !hasEarlier");
    expect(source).toContain("continueFillingViewport");
    expect(source).toContain(
      "element.scrollHeight <= element.clientHeight + LOAD_EARLIER_THRESHOLD",
    );
    expect(source).toContain("event.deltaY < 0 && updateScrollState()");
    expect(source).toContain('class="history-fallback"');
    expect(source).toContain("cancelScheduledFollow();");
  });

  it("coalesces automatic stream following into one animation frame without smooth scrolling", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("let followAnimationFrame: number | undefined");
    expect(source).toContain("void tick().then(scheduleScrollToLatest)");
    expect(source).toContain("followAnimationFrame !== undefined");
    expect(source).toContain("followAnimationFrame = requestAnimationFrame");
    expect(source).toContain('scrollToLatest("auto")');
    expect(source).not.toContain('initialScrollComplete ? "smooth"');
  });

  it("renders one explicit history entry point", () => {
    const children = createRawSnippet(() => ({
      render: () => "<article>Latest message</article>",
    }));
    const { body } = render(ConversationViewport, {
      props: {
        label: "Conversation",
        jumpToLatestLabel: "Latest",
        hasEarlier: true,
        earlierLabel: "Show earlier messages (96)",
        onLoadEarlier: async () => true,
        children,
      },
    });

    expect(body.match(/Show earlier messages \(96\)/g)).toHaveLength(1);
    expect(body.match(/<button\b/g)).toHaveLength(1);
  });
});
