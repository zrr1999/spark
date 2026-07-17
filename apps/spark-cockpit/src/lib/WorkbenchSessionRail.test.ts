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

  it("offers only workspace-scoped conversation creation", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('href="/sessions?new=workspace"');
    expect(source).not.toContain('href="/sessions"');
    expect(source).not.toContain("new=daemon");
    expect(source).not.toContain("daemonConversation");
    expect(source).not.toContain("daemonGroup");
    expect(source).not.toContain("workspaceConversation");
    expect(source).not.toContain("new-session-actions");
  });

  it("groups conversations by session type in collapsible sections", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("groupWorkbenchSessionsByType(filteredSessions");
    expect(source).toContain('<details class="session-group" open>');
    expect(source).toContain("labels: messages.sessionTypes");
  });

  it("preloads a conversation before navigation to reduce switching latency", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('data-sveltekit-preload-data="hover"');
    expect(source).toContain("/sessions/${encodeURIComponent(session.sessionId)}");
  });

  it("keeps the compact new-conversation action beside the filter", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('<div class="session-toolbar">');
    expect(source).toContain('<label class="session-filter">');
    expect(source).toContain('<Icon name="new-message"');
    expect(source).toContain('<span class="sr-only">{messages.newSession}</span>');
    expect(source.indexOf('<label class="session-filter">')).toBeLessThan(
      source.indexOf('<Icon name="new-message"'),
    );
  });

  it("keeps cached conversations searchable while workspace control is offline", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("{#if activeWorkspaceId && !sessionControlAvailable}");
    expect(source).toContain("{#if filteredSessions.length === 0}");
    expect(source).not.toContain("disabled={!sessionsAvailable}");
  });

  it("gates mutations on workspace-scoped control availability", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("{#if sessionControlAvailable}");
    expect(source).toContain("{@const canArchive = sessionControlAvailable");
  });
});
