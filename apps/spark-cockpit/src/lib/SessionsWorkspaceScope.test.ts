import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "SessionsWorkspace.svelte");

describe("SessionsWorkspace conversation scope contract", () => {
  it("keeps workspace and daemon-global creation explicit in the same composer", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('startScope?: "workspace" | "daemon"');
    expect(source).toContain('name="scopeKind" value={startScope}');
    expect(source).toContain('!activeWorkspace && startScope === "workspace"');
    expect(source).toContain("copy.daemonStartHint");
  });
});
