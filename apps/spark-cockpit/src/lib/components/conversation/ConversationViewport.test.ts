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

function navigationItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    actor: "user" as const,
    label: "You",
    summary: `Message ${index}`,
    meta: "just now",
  }));
}

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

  it("packs rendered turns into a dense clickable navigation rail", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("ConversationTurnRail");
    expect(source).toContain('querySelectorAll<HTMLElement>("[data-message-id]")');
    expect(source).toContain("TURN_RAIL_MARKER_GAP = 10");
    expect(source).toContain("markerStart + index * markerStep");
    expect(source).not.toContain("item.top / contentHeight");
    expect(source).toContain("activeNavigationId = id");
    expect(source).toContain("target.offsetTop - 18");
    expect(source).toContain("prefers-reduced-motion: reduce");
  });

  it("hides the turn rail until the conversation has at least six turns", () => {
    const children = createRawSnippet(() => ({ render: () => "<article>Messages</article>" }));
    const shortConversation = render(ConversationViewport, {
      props: {
        label: "Conversation",
        jumpToLatestLabel: "Latest",
        navigationItems: navigationItems(5),
        children,
      },
    });
    const longConversation = render(ConversationViewport, {
      props: {
        label: "Conversation",
        jumpToLatestLabel: "Latest",
        navigationItems: navigationItems(6),
        children,
      },
    });

    expect(shortConversation.body).not.toContain('data-testid="conversation-turn-rail"');
    expect(longConversation.body).toContain('data-testid="conversation-turn-rail"');
  });

  it("loads history near the top while preserving the visible message anchor", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("LOAD_EARLIER_THRESHOLD = 96");
    expect(source).toContain("viewport.scrollTop <= LOAD_EARLIER_THRESHOLD");
    expect(source).toContain("captureConversationPrependAnchor(element)");
    expect(source).toContain("restoreConversationPrependAnchor(element, anchor)");
    expect(source).toContain("suspendFollow = true");
    expect(source).toContain("initialScrollComplete = $state(false)");
    expect(source).toContain("!element || !initialScrollComplete || !hasEarlier || earlierFailed");
    expect(source).toContain("continueFillingViewport");
    expect(source).toContain(
      "element.scrollHeight <= element.clientHeight + LOAD_EARLIER_THRESHOLD",
    );
    expect(source).toContain("event.deltaY < 0 && updateScrollState()");
    expect(source).toContain("{#if earlierFailed && hasEarlier && onLoadEarlier}");
    expect(source).toContain("if (!force && earlierFailed) return;");
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

  it("does not require a manual history entry point during normal scrolling", () => {
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

    expect(body).not.toContain("Show earlier messages (96)");
    expect(body).not.toMatch(/<button\b/u);
  });
});
