import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "ChannelSessionIcon.svelte");

describe("ChannelSessionIcon component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("combines adapter and scope icons behind one accessible label", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('role="img"');
    expect(source).toContain("aria-label={label}");
    expect(source).toContain("title={label}");
    expect(source).toContain('adapter === "qqbot"');
    expect(source).toContain("channelSessionScopeKind(adapter, scope)");
    expect(source).toContain('scopeKind === "private"');
    expect(source).toContain('scopeKind === "group"');
    expect(source).toContain('scopeKind === "channel"');
    expect(source).toContain("scope-{scopeKind}");
    expect(source).toContain("--scope-color: var(--color-info)");
    expect(source).toContain("--scope-color: var(--color-purple)");
    expect(source).toContain("@media (forced-colors: active)");
  });
});
