import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const pagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/[workspaceId]/settings/channels/+page.svelte",
);
const serverPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/[workspaceId]/settings/channels/+page.server.ts",
);

describe("channel settings page contract", () => {
  it("compiles as a Svelte page", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(() => compile(source, { filename: pagePath, generate: "server" })).not.toThrow();
  });

  it("offers a discoverable route from account settings back to a clean connection form", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("freshMessagePlatformFormValues({");
    expect(source).toContain("function startConnectPlatform() {");
    expect(source).toContain("values = freshPlatformValues();");
    expect(source).toContain("onclick={startConnectPlatform}");
    expect(source).toContain('<Icon name="plus" size={14} />');
    expect(source).toContain('action="?/savePlatform"');
  });

  it("renders adapter accounts instead of duplicating their conversation sessions", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("{#each platforms as platform (platform.adapter)}");
    expect(source).toContain("platform.accountId");
    expect(source).toContain("t.sessionIdentityHint");
    expect(source).not.toContain("formatChannelSessionTitle");
    expect(source).not.toContain("channel.bindings");
    expect(source).not.toContain("/sessions/${channel.sessionId}");
    expect(source).not.toContain('name="scope"');
    expect(source).not.toContain('name="externalId"');
  });

  it("saves only the account connection and never creates or binds a session", () => {
    const source = readFileSync(serverPath, "utf8");

    expect(source).toContain("savePlatform: async");
    expect(source).toContain("saveChannelsConfigForCockpit(workspaceId, merged, context)");
    expect(source).toContain("requireSecretRequestContext(event)");
    expect(source).not.toContain("createManagedSessionForCockpit");
    expect(source).not.toContain("bindManagedSessionForCockpit");
    expect(source).not.toContain("archiveManagedSessionForCockpit");
    expect(source).not.toContain("createChannelExternalKey");
  });
});
