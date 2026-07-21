// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionAskPanel from "./SessionAskPanel.svelte";
import { getDictionary } from "./i18n";
import type { PendingWorkbenchAsk } from "./pending-ask";

const appMocks = vi.hoisted(() => ({
  formSubmits: vi.fn(),
  invalidates: vi.fn(),
}));

vi.mock("$app/forms", () => ({
  enhance: (form: HTMLFormElement) => {
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      appMocks.formSubmits();
    };
    form.addEventListener("submit", onSubmit);
    return { destroy: () => form.removeEventListener("submit", onSubmit) };
  },
}));

vi.mock("$app/navigation", () => ({ invalidateAll: appMocks.invalidates }));

const libRoot = dirname(fileURLToPath(import.meta.url));
const inboxPagePath = resolve(
  libRoot,
  "../routes/(workbench)/[workspaceId]/inbox/[inboxItemId]/+page.svelte",
);
const inboxServerPath = resolve(
  libRoot,
  "../routes/(workbench)/[workspaceId]/inbox/[inboxItemId]/+page.server.ts",
);
const layoutPath = resolve(libRoot, "../routes/(workbench)/+layout.svelte");
const workspacePath = resolve(libRoot, "SessionsWorkspace.svelte");
const messages = getDictionary("en").inboxDetail;
const ask: PendingWorkbenchAsk = {
  id: "inbox_preview",
  workspaceId: "ws_preview",
  workspaceSlug: "preview",
  sessionId: "sess_preview",
  title: "Choose a preview",
  prompt: "Pick the best direction or write another one.",
  questions: [
    {
      id: "direction",
      type: "preview",
      prompt: "Which direction?",
      required: true,
      options: [
        {
          value: "compact",
          label: "Compact",
          description: "Keep the change focused.",
          preview: "src/compact.ts\n+export const compact = true;",
        },
      ],
    },
  ],
  detailHref: "/preview/inbox/inbox_preview",
  createdAt: "2026-07-17T00:00:00.000Z",
  pendingCount: 2,
};

let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) {
    await unmount(mounted);
  }
  mounted = undefined;
  document.body.replaceChildren();
  appMocks.formSubmits.mockClear();
  appMocks.invalidates.mockClear();
});

describe("SessionAskPanel", () => {
  it("renders an inline ask form for the session composer", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(SessionAskPanel, { target, props: { ask, messages } });
    await tick();

    expect(document.querySelector("#session-ask-title")?.textContent).toBe("Choose a preview");
    expect(document.querySelector(".option-preview")?.textContent).toContain(
      "export const compact = true",
    );
    expect(
      document.querySelector('form[action="/preview/inbox/inbox_preview?/respond"]'),
    ).toBeTruthy();
    expect(document.querySelector(".pending-count")?.textContent).toBe("2");
  });

  it("is mounted from the session composer, not a global dialog", () => {
    const layout = readFileSync(layoutPath, "utf8");
    const workspace = readFileSync(workspacePath, "utf8");
    expect(layout).not.toContain("GlobalAskDialog");
    expect(workspace).toContain("SessionAskPanel");
    expect(workspace).toContain("sessionPendingAsk");
  });

  it("shares unconditional custom replies across the panel and Inbox detail", () => {
    const inboxPage = readFileSync(inboxPagePath, "utf8");
    const inboxServer = readFileSync(inboxServerPath, "utf8");

    expect(inboxPage).toContain("<AskQuestionField");
    expect(inboxServer).toContain("humanSingleAnswerWithCustomFallback");
    expect(inboxServer).toContain("humanMultiAnswerWithCustomFallback");
    expect(inboxServer).not.toContain('question.type === "preview"');
    expect(inboxPage).not.toContain("allowOther");
  });
});
