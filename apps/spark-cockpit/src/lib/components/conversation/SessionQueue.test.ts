import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import SessionQueue from "./SessionQueue.svelte";

const componentRoot = dirname(fileURLToPath(import.meta.url));
const componentPath = resolve(componentRoot, "SessionQueue.svelte");
const labels = {
  region: "QUEUE_REGION",
  queued: "WAITING_LABEL",
  next: "NEXT_LABEL",
};
const item = {
  id: "inv_follow_up",
  text: "continue with the implementation",
  description: "just now",
};

describe("SessionQueue component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("renders no queue shell when the daemon reports no queued turns", () => {
    const { body } = render(SessionQueue, {
      props: { items: [], labels, hasRunningTurn: false },
    });

    expect(body).not.toContain("data-session-queue");
  });

  it("labels a lone queued turn as waiting when no turn is running", () => {
    const { body } = render(SessionQueue, {
      props: { items: [item], labels, hasRunningTurn: false },
    });

    expect(body).toContain("WAITING_LABEL");
    expect(body).not.toContain("NEXT_LABEL");
    expect(body).toContain(item.text);
    expect(body).not.toContain("<details");
  });

  it("labels a lone follow-up as next only behind a genuinely running turn", () => {
    const { body } = render(SessionQueue, {
      props: { items: [item], labels, hasRunningTurn: true },
    });

    expect(body).toContain("NEXT_LABEL");
    expect(body).not.toContain("WAITING_LABEL");
    expect(body).toContain(item.text);
  });

  it("uses the bounded counted disclosure for multiple queued turns", () => {
    const secondItem = { ...item, id: "inv_second", text: "then run the tests" };
    const { body } = render(SessionQueue, {
      props: { items: [item, secondItem], labels, hasRunningTurn: true },
    });

    expect(body).toMatch(/<details\b[^>]*\bopen(?:="")?/);
    expect(body).toMatch(/<span class="queue-count[^"]*">2<\/span>/);
    expect(body).toContain("WAITING_LABEL");
    expect(body).toContain(item.text);
    expect(body).toContain(secondItem.text);
  });

  it("keeps the queue bounded and long display-safe prompts readable", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("max-height: 10rem;");
    expect(source).toContain("overflow-y: auto;");
    expect(source).toContain("overflow-wrap: anywhere;");
    expect(source).toContain("-webkit-line-clamp: 2;");
    expect(source).toContain("title={item.text}");
  });

  it("delegates item actions without creating a browser-local queue or form path", () => {
    const source = readFileSync(componentPath, "utf8");
    const index = readFileSync(resolve(componentRoot, "index.ts"), "utf8");

    expect(index).toContain("actions?: Snippet<[SessionQueueItem]>");
    expect(index).toContain("hasRunningTurn: boolean;");
    expect(index).toContain("next: string;");
    expect(source).toContain("{@render actions(item)}");
    expect(source).toContain(".single-queue-item .queue-item-actions");
    expect(source).toContain(".queue-item:focus-within .queue-item-actions");
    expect(source).toContain("@media (hover: none)");
    expect(source).not.toContain("<form");
    expect(source).not.toContain("onclick=");
    expect(source).not.toContain("$state");
    expect(source).not.toContain("queuedMessages");
  });

  it("exports the component and its daemon-facing presentation types", () => {
    const index = readFileSync(resolve(componentRoot, "index.ts"), "utf8");

    expect(index).toContain('export { default as SessionQueue } from "./SessionQueue.svelte"');
    expect(index).toContain("SessionQueueItem");
    expect(index).toContain("SessionQueueLabels");
    expect(index).toContain("SessionQueueProps");
  });
});
