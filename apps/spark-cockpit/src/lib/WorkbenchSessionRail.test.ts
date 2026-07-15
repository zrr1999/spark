import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "WorkbenchSessionRail.svelte",
);

describe("WorkbenchSessionRail component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("uses compact channel identity icons without a message-platform badge", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("channelSessionPresentation(session");
    expect(source).toContain("<ChannelSessionIcon");
    expect(source).toContain("<strong>{presentation.title}</strong>");
    expect(source).not.toContain('<span class="channel-badge">');
    expect(source).not.toContain(".channel-badge {");
  });

  it("keeps channel sessions non-archivable", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("!sessionHasChannelBinding(session)");
  });
});
