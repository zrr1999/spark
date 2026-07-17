// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SlashCommandMenu from "./SlashCommandMenu.svelte";
import type { SlashCommandSuggestion } from "./slash-command";

const suggestions: readonly SlashCommandSuggestion[] = [
  {
    id: "sessions",
    command: "sessions",
    title: "Choose a session",
    description: "Open the session chooser.",
  },
  {
    id: "model",
    command: "model",
    title: "Choose a model",
    description: "Change the model and reasoning effort.",
  },
];

let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
});

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Expected slash command menu element: ${selector}`);
  return element;
}

async function renderMenu(
  props: Partial<{
    suggestions: readonly SlashCommandSuggestion[];
    activeIndex: number;
    hint: string;
    onActiveIndexChange: (index: number) => void;
    onSelect: (suggestion: SlashCommandSuggestion) => void;
  }> = {},
) {
  const form = document.createElement("form");
  const textarea = document.createElement("textarea");
  const target = document.createElement("div");
  form.append(textarea, target);
  document.body.append(form);

  mounted = mount(SlashCommandMenu, {
    target,
    props: {
      id: "composer-slash-commands",
      suggestions,
      activeIndex: 0,
      ariaLabel: "Available commands",
      ...props,
    },
  });
  await tick();
  return { form, textarea };
}

describe("SlashCommandMenu", () => {
  it("exposes the active suggestion as an accessible listbox option", async () => {
    await renderMenu({ activeIndex: 1, hint: "Use arrows, Enter, or Tab" });

    const listbox = requiredElement<HTMLElement>('[role="listbox"]');
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];

    expect(listbox.id).toBe("composer-slash-commands");
    expect(listbox.getAttribute("aria-label")).toBe("Available commands");
    expect(options).toHaveLength(2);
    expect(options[1]?.id).toBe("composer-slash-commands-option-1");
    expect(options[0]?.getAttribute("aria-selected")).toBe("false");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options[0]?.textContent).toContain("/sessions");
    expect(options[0]?.textContent).toContain("Open the session chooser.");
    expect(document.querySelector(".slash-command-hint")?.textContent).toBe(
      "Use arrows, Enter, or Tab",
    );
  });

  it("preserves editor focus while selecting a command without submitting its form", async () => {
    const onActiveIndexChange = vi.fn();
    const onSelect = vi.fn();
    const { form, textarea } = await renderMenu({ onActiveIndexChange, onSelect });
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    form.addEventListener("submit", onSubmit);
    textarea.focus();

    const modelOption = requiredElement<HTMLButtonElement>("#composer-slash-commands-option-1");
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    modelOption.dispatchEvent(pointerDown);

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);

    modelOption.click();
    await tick();

    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    expect(onSelect).toHaveBeenCalledWith(suggestions[1]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
  });

  it("tracks the pointer-highlighted option without selecting it", async () => {
    const onActiveIndexChange = vi.fn();
    const onSelect = vi.fn();
    await renderMenu({ onActiveIndexChange, onSelect });

    requiredElement<HTMLButtonElement>("#composer-slash-commands-option-1").dispatchEvent(
      new MouseEvent("mouseenter"),
    );
    await tick();

    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not render an empty completion surface", async () => {
    await renderMenu({ suggestions: [] });

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
