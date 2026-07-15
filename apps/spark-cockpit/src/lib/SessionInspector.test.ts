import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "SessionInspector.svelte");
const workspacePath = resolve(dirname(fileURLToPath(import.meta.url)), "SessionsWorkspace.svelte");

describe("SessionInspector component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("renders the four focused coding-session views with explicit empty states", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('id: "summary"');
    expect(source).toContain('id: "changes"');
    expect(source).toContain('id: "tasks"');
    expect(source).toContain('id: "mailbox"');
    expect(source).not.toContain('id: "evidence"');
    expect(source).not.toContain('id: "context"');
    expect(source).not.toContain("view.runs");
    expect(source).not.toContain("labels.noRunsTitle");
    expect(source).not.toContain("labels.noRunsBody");
    expect(source).not.toContain("labels.runsHeading");
    expect(source).toContain("view.tasks");
    expect(source).toContain("view.changes");
    expect(source).toContain("view.mailbox");
    expect(source).toContain("view.context");
    expect(source).toContain("labels.noTasksTitle");
    expect(source).toContain("labels.noTasksBody");
    expect(source).toContain("labels.noChangesTitle");
    expect(source).toContain("labels.noChangesBody");
    expect(source).toContain("labels.noMailboxTitle");
    expect(source).toContain("labels.noMailboxBody");
    expect(source).toContain("justify-content: center");
  });

  it("does not expose invented Git or terminal controls", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).not.toContain("git status");
    expect(source).not.toContain("terminal.write");
    expect(source).not.toContain("<form");
  });

  it("groups only canonical task project references without inventing project metadata", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("groupTasksByProject(view.tasks)");
    expect(source).toContain("task.projectRef ??");
    expect(source).toContain("labels.unassignedProject");
    expect(source).not.toContain("project.title");
    expect(source).not.toContain("project.status");
  });

  it("names tabs, panels, and headings from the inspector instance", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("instanceId: string");
    expect(source).toContain("`${instanceId}-${tab}-tab`");
    expect(source).toContain("`${instanceId}-${tab}-panel`");
    expect(source).toContain("`${instanceId}-${section}-heading`");
    expect(source).not.toContain('id="session-inspector-runs-heading"');

    const workspace = readFileSync(workspacePath, "utf8");
    expect(workspace).toContain(
      'compact ? "session-inspector-mobile" : "session-inspector-desktop"',
    );
  });

  it("derives busy presentation from an active invocation instead of stale session flags", () => {
    const workspace = readFileSync(workspacePath, "utf8");

    expect(workspace).toContain("let conversationBusy = $derived(Boolean(activeTurnId))");
    expect(workspace).not.toContain('selected?.status === "running" ||');
    expect(workspace).toContain(
      'const effectiveStatus: "running" | "idle" = conversationBusy ? "running" : "idle"',
    );
  });
});
