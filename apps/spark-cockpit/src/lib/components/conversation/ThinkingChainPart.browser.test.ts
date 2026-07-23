import { page } from "vitest/browser";
import { expect, test } from "vitest";
import { render } from "vitest-browser-svelte";
import type { RenderResult } from "vitest-browser-svelte";

import ThinkingChainPart from "./ThinkingChainPart.svelte";
import {
  activeThinkingChainSteps,
  thinkingChainLabels as labels,
} from "./ThinkingChainPart.test-fixtures";

const props = {
  state: "streaming" as const,
  steps: activeThinkingChainSteps,
  labels,
  statusLabel: (status: string) => `STATUS_${status}`,
};

function byCss(screen: RenderResult<typeof ThinkingChainPart>, selector: string) {
  const element = screen.container.querySelector(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return page.elementLocator(element);
}

test("opens streaming execution and presents step and failure states", async () => {
  const screen = await render(ThinkingChainPart, props);
  const chain = byCss(screen, "details.thinking-chain");

  await expect.element(chain).toHaveAttribute("open");
  await expect.element(screen.getByText("CHAIN_STREAMING")).toBeVisible();
  await expect.element(screen.getByText("Investigating the first divergence")).toBeVisible();
  await expect.element(screen.getByText("The focused probe is running")).toBeVisible();
  await expect
    .element(screen.getByText("Running focused probe", { exact: true }).first())
    .toBeVisible();
  await expect.element(screen.getByText("search", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("STATUS_pending", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("exec", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("STATUS_running", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("edit", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("STATUS_failed", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("CHAIN_FAILED")).toBeVisible();

  await byCss(screen, "details.thinking-chain > summary").click();
  await expect.element(byCss(screen, "details.thinking-chain")).not.toHaveAttribute("open");
});

test("folds when streaming completes and preserves a later user expansion", async () => {
  const screen = await render(ThinkingChainPart, props);

  await expect.element(byCss(screen, "details.thinking-chain")).toHaveAttribute("open");
  await screen.rerender({ ...props, state: "complete" });
  await expect.element(byCss(screen, "details.thinking-chain")).not.toHaveAttribute("open");
  await expect.element(screen.getByText("CHAIN_COMPLETE")).toBeVisible();

  await byCss(screen, "details.thinking-chain > summary").click();
  await expect.element(byCss(screen, "details.thinking-chain")).toHaveAttribute("open");
  await expect.element(screen.getByText("Investigating the first divergence")).toBeVisible();
});
