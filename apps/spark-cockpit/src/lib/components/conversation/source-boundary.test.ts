import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const conversationRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(conversationRoot, "../../../..");
const pinnedCommit = "fa4bc217f84bc571378bc371332a154106772614";

describe("source-derived conversation component boundary", () => {
  it("pins upstream provenance and retains the complete MIT notice", () => {
    const vendor = readFileSync(join(conversationRoot, "VENDOR.md"), "utf8");
    const license = readFileSync(join(conversationRoot, "UPSTREAM-LICENSE.txt"), "utf8");

    expect(vendor).toContain("https://github.com/SikandarJODD/ai-elements");
    expect(vendor).toContain(pinnedCommit);
    expect(vendor).toContain("source-derived Spark components, not a registry snapshot");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Sikandar Bhide");
    expect(license).toContain("The above copyright notice and this permission notice");
  });

  it("keeps provider and AI chat runtimes outside the source-derived conversation shell", () => {
    const source = sourceFiles(conversationRoot)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];

    expect(source).not.toMatch(/from\s+["']ai["']/);
    expect(source).not.toContain("@ai-sdk/svelte");
    expect(source).not.toMatch(/from\s+["']shiki["']/);
    expect(source).not.toContain("tailwindcss");
    expect(source).not.toContain("UIMessage");
    expect(source).not.toContain("ToolUIPart");
    expect(source).not.toContain("FileUIPart");
    expect(dependencyNames).not.toContain("ai");
    expect(dependencyNames).not.toContain("@ai-sdk/svelte");
    expect(dependencyNames).toContain("svelte-streamdown");
    expect(dependencyNames).not.toContain("@shikijs/themes");
    expect(dependencyNames).not.toContain("tailwindcss");
  });

  it("integrates presentation components without replacing the daemon form path", () => {
    const workspace = readFileSync(join(appRoot, "src/lib/SessionsWorkspace.svelte"), "utf8");
    const startPane = readFileSync(
      join(appRoot, "src/lib/sessions-workspace/SessionStartPane.svelte"),
      "utf8",
    );
    const conversationPane = readFileSync(
      join(appRoot, "src/lib/sessions-workspace/SessionConversationPane.svelte"),
      "utf8",
    );
    const stageHeader = readFileSync(
      join(appRoot, "src/lib/sessions-workspace/SessionStageHeader.svelte"),
      "utf8",
    );
    const composerPane = readFileSync(
      join(appRoot, "src/lib/sessions-workspace/SessionComposerPane.svelte"),
      "utf8",
    );
    const shell = `${workspace}\n${startPane}\n${conversationPane}\n${stageHeader}\n${composerPane}`;

    expect(shell).toContain("<ConversationViewport");
    expect(shell).toContain("{#key host.selected.sessionId}");
    expect(shell).toContain("<ConversationMessage");
    expect(shell).toContain("<Composer");
    expect(shell).toContain("<ModelRuntimeControl");
    expect(shell).toContain('action="?/sendMessage"');
    expect(shell).toContain('action="?/selectModel"');
    expect(shell).toContain('action="?/selectThinking"');
    expect(shell).toContain("use:enhance={enhanceSendMessage}");
    expect(shell).toContain("host.enhanceSendMessage(submission)");
    expect(startPane).toContain('name="submissionId" value={startSubmissionId}');
    expect(shell).toContain('name="submissionId" value={host.sendSubmissionId}');
    expect(shell).toContain("retryAction={item.id === host.retryableTimelineItemId");
    expect(workspace).not.toContain("<SessionRetryAction");
    expect(workspace).not.toContain('class="timeline-entry');
    expect(workspace).not.toContain('class="message-block');
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || ![".svelte", ".ts"].includes(extname(entry.name))) return [];
    return entry.name.endsWith(".test.ts") ? [] : [path];
  });
}
