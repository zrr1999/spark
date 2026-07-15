import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "ProjectTaskBoard.svelte");

describe("ProjectTaskBoard component contract", () => {
  it("renders board columns, evidence links, and assign forms in the browser-facing component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("aria-label={messages.aria}");
    expect(source).toContain("{#each columns as column}");
    expect(source).toContain('class="task-card"');
    expect(source).toContain("{messages.readyFrontier}");
    expect(source).toContain('class="evidence-links"');
    expect(source).toContain("href={`${workspaceUrl}/artifacts/${artifact.id}`}");
    expect(source).toContain('action="?/assignTask"');
    expect(source).toContain('name="runtimeTaskId"');
    expect(source).toContain("card.assignable ? messages.assign : messages.notAssignable");
  });
});
