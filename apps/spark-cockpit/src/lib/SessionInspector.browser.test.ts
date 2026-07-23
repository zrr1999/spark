import { userEvent } from "vitest/browser";
import { expect, test } from "vitest";
import { render } from "vitest-browser-svelte";

import SessionInspector from "./SessionInspector.svelte";
import {
  sessionInspectorLabels as labels,
  sessionWorkbenchView,
} from "./SessionInspector.test-fixtures";

test("switches inspector tabs by click and roving keyboard focus", async () => {
  const screen = await render(SessionInspector, {
    view: sessionWorkbenchView(),
    labels,
    instanceId: "inspector-browser",
  });
  const summary = screen.getByRole("tab", { name: "SUMMARY_TAB" });
  const artifacts = screen.getByRole("tab", { name: "ARTIFACTS_TAB" });
  const changes = screen.getByRole("tab", { name: "CHANGES_TAB" });
  const messages = screen.getByRole("tab", { name: "MESSAGES_TAB" });

  await expect.element(summary).toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByRole("heading", { name: "SUMMARY_HEADING" })).toBeVisible();

  await artifacts.click();
  await expect.element(artifacts).toHaveAttribute("aria-selected", "true");
  await expect
    .element(screen.getByRole("heading", { name: "NO_ARTIFACTS", exact: true }))
    .toBeVisible();

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(changes).toHaveAttribute("aria-selected", "true");
  await expect.element(changes).toHaveFocus();
  await expect
    .element(screen.getByRole("heading", { name: "NO_CHANGES", exact: true }))
    .toBeVisible();

  await userEvent.keyboard("{End}");
  await expect.element(messages).toHaveAttribute("aria-selected", "true");
  await expect.element(messages).toHaveFocus();
  await expect
    .element(screen.getByRole("heading", { name: "NO_MESSAGES", exact: true }))
    .toBeVisible();

  await userEvent.keyboard("{Home}");
  await expect.element(summary).toHaveAttribute("aria-selected", "true");
  await expect.element(summary).toHaveFocus();
  await expect.element(screen.getByRole("heading", { name: "SUMMARY_HEADING" })).toBeVisible();
});
