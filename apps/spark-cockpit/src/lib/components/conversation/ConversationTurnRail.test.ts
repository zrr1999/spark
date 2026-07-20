import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ConversationTurnRail from "./ConversationTurnRail.svelte";

const componentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "ConversationTurnRail.svelte",
);

describe("ConversationTurnRail", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("renders accessible turn markers with an active location and previews", () => {
    const { body } = render(ConversationTurnRail, {
      props: {
        label: "Conversation turns",
        activeId: "turn-2",
        positions: { "turn-1": 12, "turn-2": 78 },
        items: [
          {
            id: "turn-1",
            actor: "user",
            label: "You",
            summary: "Inspect the current implementation",
            meta: "2 minutes ago",
          },
          {
            id: "turn-2",
            actor: "session",
            label: "Agent · verifier",
            summary: "Verify the completed change",
            meta: "just now",
          },
        ],
      },
    });

    expect(body).toContain('data-testid="conversation-turn-rail"');
    expect(body).toContain('aria-current="location"');
    expect(body).toContain("You: Inspect the current implementation");
    expect(body).toContain("Agent · verifier");
    expect(body).toContain("--turn-position: 78%");
  });

  it("keeps the preview visible outside the compact marker hit target", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).not.toContain("turn-scale");
    expect(source).toContain("left: 0;");
    expect(source).toContain("height: 12px;");
    expect(source).toContain("width: 6px;");
    expect(source).toContain("width: 22px;");
    expect(source).toContain("overflow: visible;");
    expect(source).toContain(".turn-marker:hover .turn-preview");
    expect(source).toContain(".turn-marker:focus-visible .turn-preview");
  });
});
