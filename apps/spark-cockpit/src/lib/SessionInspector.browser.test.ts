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
  const summary = screen.getByRole("tab", { name: labels.tabs.summary });
  const artifacts = screen.getByRole("tab", { name: labels.tabs.artifacts });
  const changes = screen.getByRole("tab", { name: labels.tabs.changes });
  const tasks = screen.getByRole("tab", { name: labels.tabs.tasks });

  await expect.element(summary).toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByRole("heading", { name: labels.summaryHeading })).toBeVisible();

  await artifacts.click();
  await expect.element(artifacts).toHaveAttribute("aria-selected", "true");
  await expect
    .element(screen.getByRole("heading", { name: labels.noArtifactsTitle, exact: true }))
    .toBeVisible();

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(changes).toHaveAttribute("aria-selected", "true");
  await expect.element(changes).toHaveFocus();
  await expect
    .element(screen.getByRole("heading", { name: labels.noChangesTitle, exact: true }))
    .toBeVisible();

  await userEvent.keyboard("{End}");
  await expect.element(tasks).toHaveAttribute("aria-selected", "true");
  await expect.element(tasks).toHaveFocus();
  await expect
    .element(screen.getByRole("heading", { name: labels.noTasksTitle, exact: true }))
    .toBeVisible();

  await userEvent.keyboard("{Home}");
  await expect.element(summary).toHaveAttribute("aria-selected", "true");
  await expect.element(summary).toHaveFocus();
  await expect.element(screen.getByRole("heading", { name: labels.summaryHeading })).toBeVisible();
});
