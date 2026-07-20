// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import GlobalAskDialog from "./GlobalAskDialog.svelte";
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
const messages = getDictionary("en").inboxDetail;
const ask: PendingWorkbenchAsk = {
  id: "inbox_preview",
  workspaceId: "ws_preview",
  workspaceSlug: "preview",
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
const originalWarn = console.warn.bind(console);

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    // Completing Bits UI's CSS animation manually is what lets jsdom exercise
    // the real unmount/remount path. Svelte dev mode warns while that synthetic
    // animation event destroys Bits UI's derived presence state.
    if (args.some((value) => String(value).includes("derived_inert"))) return;
    originalWarn(...args);
  });

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  if (mounted) {
    await unmount(mounted);
    // Bits UI defers body-scroll restoration for 24 ms. Let that cleanup run
    // before Vitest disposes jsdom and removes the global document.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 32));
  }
  mounted = undefined;
  document.body.replaceChildren();
  appMocks.formSubmits.mockClear();
  appMocks.invalidates.mockClear();
});

async function renderDialog() {
  const target = document.createElement("div");
  document.body.append(target);
  mounted = mount(GlobalAskDialog, { target, props: { ask, messages }, intro: false });
  await tick();
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Expected dialog element: ${selector}`);
  return element;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Expected button: ${text}`);
  return button;
}

async function enterCustomDraft(value: string) {
  const textarea = requiredElement<HTMLTextAreaElement>(
    'textarea[aria-label="Which direction?: Custom reply"]',
  );
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  await tick();
  expect(requiredElement<HTMLInputElement>("[data-custom-answer-choice]").checked).toBe(true);
}

async function expectMinimizedDraft(value: string) {
  await tick();
  const closedContent = requiredElement<HTMLElement>(".ui-dialog-content");
  expect(closedContent.dataset.state).toBe("closed");
  const recovery = requiredElement<HTMLButtonElement>(".ask-recovery button");
  expect(recovery.getAttribute("aria-label")).toContain("2 pending requests");
  expect(appMocks.formSubmits).not.toHaveBeenCalled();
  expect(appMocks.invalidates).not.toHaveBeenCalled();

  for (const element of document.querySelectorAll<HTMLElement>(
    ".ui-dialog-content, .ui-dialog-overlay",
  )) {
    element.dispatchEvent(new Event("animationend"));
  }
  await tick();
  expect(document.querySelector(".ui-dialog-content")).toBeNull();

  recovery.click();
  await tick();
  await tick();
  expect(requiredElement<HTMLElement>(".ui-dialog-content").dataset.state).toBe("open");
  expect(
    requiredElement<HTMLTextAreaElement>('textarea[aria-label="Which direction?: Custom reply"]')
      .value,
  ).toBe(value);
  expect(requiredElement<HTMLInputElement>("[data-custom-answer-choice]").checked).toBe(true);
}

describe("GlobalAskDialog", () => {
  it.each([
    [
      "Close",
      () => requiredElement<HTMLButtonElement>('button[aria-label="Minimize request"]').click(),
    ],
    ["Answer later", () => buttonWithText("Answer later").click()],
    [
      "Escape",
      () =>
        requiredElement<HTMLTextAreaElement>(
          'textarea[aria-label="Which direction?: Custom reply"]',
        ).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    ],
  ])("%s minimizes without submitting and restores the form draft", async (_label, minimize) => {
    await renderDialog();
    expect(requiredElement<HTMLElement>(".option-preview").textContent).toContain(
      "export const compact = true",
    );
    await enterCustomDraft("Keep my custom direction");

    minimize();
    await expectMinimizedDraft("Keep my custom direction");
  });

  it("shares unconditional custom replies across the dialog and Inbox detail", () => {
    const inboxPage = readFileSync(inboxPagePath, "utf8");
    const inboxServer = readFileSync(inboxServerPath, "utf8");

    expect(inboxPage).toContain("<AskQuestionField");
    expect(inboxServer).toContain("humanSingleAnswerWithCustomFallback");
    expect(inboxServer).toContain("humanMultiAnswerWithCustomFallback");
    expect(inboxServer).not.toContain('question.type === "preview"');
    expect(inboxPage).not.toContain("allowOther");
  });
});
