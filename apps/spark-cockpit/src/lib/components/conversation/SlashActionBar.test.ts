// @vitest-environment jsdom

import type { SparkActionBarView, SparkActionView } from "@zendev-lab/spark-protocol";
import { mount, tick, unmount, type ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SlashActionBar from "./SlashActionBar.svelte";

const view: SparkActionBarView = {
  id: "model",
  title: "Model controls",
  description: "Choose the active model.",
  actions: [
    {
      id: "select-model",
      label: "Choose model",
      description: "Open the model picker.",
      intent: "model.select",
      payload: {},
      tone: "primary",
    },
    {
      id: "inspect-providers",
      label: "Providers",
      description: "Inspect configured providers.",
      intent: "settings.providers",
      payload: {},
    },
  ],
};

let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
});

async function renderActionBar(props: Partial<ComponentProps<typeof SlashActionBar>> = {}) {
  const form = document.createElement("form");
  const target = document.createElement("div");
  form.append(target);
  document.body.append(form);

  mounted = mount(SlashActionBar, {
    target,
    props: { view, ...props },
  });
  await tick();
  return { form };
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Expected slash action button: ${text}`);
  return button;
}

describe("SlashActionBar", () => {
  it("dispatches an enabled semantic action without submitting the surrounding form", async () => {
    const onAction = vi.fn();
    const { form } = await renderActionBar({ onAction });
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    form.addEventListener("submit", onSubmit);
    const chooseModel = buttonWithText("Choose model");

    expect(chooseModel.type).toBe("button");
    chooseModel.click();
    await tick();

    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(view.actions[0]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the live disabled reason and refuses the unavailable action", async () => {
    const onAction = vi.fn();
    await renderActionBar({
      resolveAction: (action: SparkActionView) =>
        action.id === "select-model"
          ? { enabled: false, reason: "No models are configured" }
          : { enabled: true },
      onAction,
    });
    const chooseModel = buttonWithText("Choose model");
    const providers = buttonWithText("Providers");

    expect(chooseModel.disabled).toBe(true);
    expect(chooseModel.title).toBe("No models are configured");
    expect(chooseModel.textContent).toContain("No models are configured");
    expect(providers.disabled).toBe(false);

    chooseModel.click();
    await tick();
    expect(onAction).not.toHaveBeenCalled();
  });
});
