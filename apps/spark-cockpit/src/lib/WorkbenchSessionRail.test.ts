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

  it("offers separate workspace and global conversation creation", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('href="/sessions?new=workspace"');
    expect(source).toContain('href="/sessions?new=daemon"');
    expect(source).toContain("daemonConversation");
    expect(source).toContain("daemonGroup");
  });

  it("groups conversations by session type in collapsible sections", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("groupWorkbenchSessionsByType(filteredSessions");
    expect(source).toContain('<details class="session-group" open>');
    expect(source).toContain("labels: messages.sessionTypes");
  });

  it("keeps compact new-conversation actions beside the filter", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('<div class="session-toolbar">');
    expect(source).toContain('<div class="new-session-actions">');
    expect(source).toContain('<label class="session-filter">');
    expect(source).toContain('<span class="sr-only">{messages.workspaceConversation}</span>');
    expect(source).toContain('<span class="sr-only">{messages.daemonConversation}</span>');
  });
});
