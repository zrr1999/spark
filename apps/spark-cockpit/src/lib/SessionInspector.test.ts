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

  it("renders the five read-only coding-session views with explicit empty states", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('id: "runs"');
    expect(source).toContain('id: "changes"');
    expect(source).toContain('id: "evidence"');
    expect(source).toContain('id: "mailbox"');
    expect(source).toContain('id: "context"');
    expect(source).toContain("view.runs");
    expect(source).toContain("view.tasks");
    expect(source).toContain("view.changes");
    expect(source).toContain("view.evidence");
    expect(source).toContain("view.mailbox");
    expect(source).toContain("view.context");
    expect(source).toContain("labels.noChangesTitle");
    expect(source).toContain("labels.noChangesBody");
    expect(source).toContain("labels.noMailboxTitle");
    expect(source).toContain("labels.noMailboxBody");
  });

  it("does not expose invented Git or terminal controls", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).not.toContain("git status");
    expect(source).not.toContain("terminal.write");
    expect(source).not.toContain("<form");
  });

  it("keeps daemon artifacts read-only until a canonical Cockpit route exists", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).not.toContain("artifactHref");
    expect(source).not.toContain('class="artifact-link"');
    expect(source).not.toContain("/artifacts/");
    expect(source).toContain('<code class="artifact-ref">{artifact.ref}</code>');
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
});
