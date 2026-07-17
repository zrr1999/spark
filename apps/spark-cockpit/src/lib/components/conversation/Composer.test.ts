// @vitest-environment jsdom

import { createRawSnippet, mount, tick, unmount, type ComponentProps } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "./Composer.svelte";

const baseProps: ComponentProps<typeof Composer> = {
  id: "conversation-message",
  placeholder: "Ask Spark",
  submitLabel: "Send",
  submittingLabel: "Sending",
  ariaLabel: "Message",
  multilineHint: "Shift Enter for a new line",
};

let mounted: Record<string, unknown> | undefined;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const form = document.createElement("form");
  const target = document.createElement("div");
  form.append(target);
  document.body.append(form);
  const requestSubmit = vi.spyOn(form, "requestSubmit").mockImplementation(() => undefined);

  mounted = mount(Composer, {
    target,
    props: { ...baseProps, ...props },
  });
  await tick();

  const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
  const submit = form.querySelector<HTMLButtonElement>("[data-conversation-submit]");
  if (!textarea || !submit) throw new Error("Expected mounted conversation composer controls");
  return { form, textarea, submit, requestSubmit };
}

function pressKey(textarea: HTMLTextAreaElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  textarea.dispatchEvent(event);
  return event;
}

describe("Composer", () => {
  it("submits the owning form with its send button on plain Enter", async () => {
    const { textarea, submit, requestSubmit } = await renderComposer();

    const event = pressKey(textarea, { key: "Enter" });

    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).toHaveBeenCalledOnce();
    expect(requestSubmit).toHaveBeenCalledWith(submit);
  });

  it("leaves Shift Enter and IME composition Enter to the editor", async () => {
    const { textarea, requestSubmit } = await renderComposer();

    const multiline = pressKey(textarea, { key: "Enter", shiftKey: true });
    const composing = pressKey(textarea, { key: "Enter", isComposing: true });

    expect(multiline.defaultPrevented).toBe(false);
    expect(composing.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("lets the parent keyboard controller consume Enter before form submission", async () => {
    const onKeydown = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const { textarea, requestSubmit } = await renderComposer({ onKeydown });

    const event = pressKey(textarea, { key: "Enter" });

    expect(onKeydown).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("connects an expanded completion list to the textarea combobox", async () => {
    const { textarea } = await renderComposer({
      completion: {
        expanded: true,
        listboxId: "conversation-slash-commands",
        activeOptionId: "conversation-slash-commands-option-1",
      },
    });

    expect(textarea.getAttribute("role")).toBe("combobox");
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-controls")).toBe("conversation-slash-commands");
    expect(textarea.getAttribute("aria-activedescendant")).toBe(
      "conversation-slash-commands-option-1",
    );
  });

  it("reports the live textarea value to its parent input controller", async () => {
    const onValueChange = vi.fn();
    const { textarea } = await renderComposer({ onValueChange });
    textarea.value = "/mod";

    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/mod" }));
    await tick();

    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith("/mod");
  });

  it("keeps auxiliary turn actions beside Send without changing the form submit target", async () => {
    const toolbarActions = createRawSnippet(() => ({
      render: () => '<button type="button" data-retry-latest-turn>Retry last turn</button>',
    }));
    const { form, textarea, submit, requestSubmit } = await renderComposer({ toolbarActions });
    const toolbar = form.querySelector<HTMLElement>(".composer-toolbar");
    const actionGroup = form.querySelector<HTMLElement>(".composer-submit-actions");
    const retry = form.querySelector<HTMLButtonElement>("[data-retry-latest-turn]");

    expect(toolbar).not.toBeNull();
    expect(actionGroup).not.toBeNull();
    expect(retry?.type).toBe("button");
    expect(Array.from(actionGroup?.children ?? [])).toEqual([retry, submit]);
    expect(retry?.nextElementSibling).toBe(submit);

    pressKey(textarea, { key: "Enter" });

    expect(requestSubmit).toHaveBeenCalledOnce();
    expect(requestSubmit).toHaveBeenCalledWith(submit);
  });
});
