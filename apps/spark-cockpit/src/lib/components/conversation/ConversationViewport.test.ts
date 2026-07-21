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

  it("loads history by scrolling near the top without a manual fallback button", () => {
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
    expect(source).toContain('case "busy":');
    expect(source).toContain("EARLIER_RETRY_COOLDOWN_MS");
    expect(source).toContain("EARLIER_ERROR_COOLDOWN_MS");
    expect(source).toContain("cancelScheduledFollow();");
    expect(source).not.toContain("history-fallback");
    expect(source).not.toContain("earlierFailed");
    expect(source).not.toContain("earlierLabel");
    expect(source).not.toContain("earlierErrorLabel");
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

  it("does not render a manual history entry point", () => {
    const children = createRawSnippet(() => ({
      render: () => "<article>Latest message</article>",
    }));
    const { body } = render(ConversationViewport, {
      props: {
        label: "Conversation",
        jumpToLatestLabel: "Latest",
        hasEarlier: true,
        onLoadEarlier: async () => "loaded" as const,
        children,
      },
    });

    expect(body).not.toContain("Show earlier");
    expect(body).not.toContain("history-fallback");
    expect(body).not.toMatch(/显示更早/u);
  });
});
