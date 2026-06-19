import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTaskSummaryArtifact,
  MAX_INLINE_PREVIEW_BYTES,
  truncateAgentText,
} from "./task-summary.js";

function setupWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-artifacts-"));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("task summary artifact", () => {
  it("writes a canonical Markdown file and returns an inline preview for small content", () => {
    const workspace = setupWorkspace();
    try {
      const result = buildTaskSummaryArtifact({
        workspaceLocalPath: workspace.root,
        invocationId: "inv_aaa",
        commandId: "cmd_bbb",
        commandKind: "task.start.request",
        commandTitle: "Hello world prompt",
        prompt: "Print hello world.",
        status: "succeeded",
        startedAt: "2026-05-25T00:00:00.000Z",
        completedAt: "2026-05-25T00:00:01.000Z",
        agentChunkCount: 2,
        agentTextPreview: "Hello world\n",
        agentTextTruncated: false,
      });

      expect(result.canonicalPath.startsWith(workspace.root)).toBe(true);
      expect(result.canonicalPath).toContain(".navia/artifacts/inv_aaa/task-summary.md");
      const onDisk = readFileSync(result.canonicalPath, "utf8");
      expect(onDisk).toContain("# ✅ Task succeeded");
      expect(onDisk).toContain("Print hello world.");
      expect(onDisk).toContain("Hello world");
      expect(onDisk).toContain("inv_aaa");
      expect(onDisk).toContain("cmd_bbb");

      expect(result.payload.artifactId).toMatch(/^art_/);
      expect(result.payload.format).toBe("markdown");
      expect(result.payload.kind).toBe("task-summary");
      expect(result.payload.scope).toBe("workspace");
      expect(result.payload.source).toBe("runtime");
      expect(result.payload.mime).toBe("text/markdown; charset=utf-8");
      expect(result.payload.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.payload.sizeBytes).toBe(Buffer.byteLength(onDisk));
      expect(result.payload.contentRef.runtimePathRef).toMatch(/^file:\/\//);
      expect(result.payload.contentRef.inlineMarkdown).toBe(onDisk);
      expect(result.payload.contentAvailability).toMatchObject({
        daemonAvailable: true,
        sizeBytes: result.payload.sizeBytes,
        mime: "text/markdown; charset=utf-8",
      });
      expect(result.payload.provenance).toMatchObject({
        runtimeInvocationId: "inv_aaa",
        commandKind: "task.start.request",
        commandId: "cmd_bbb",
        commandTitle: "Hello world prompt",
        status: "succeeded",
        agentChunkCount: 2,
      });
      expect(result.payload.links).toEqual([
        { targetKind: "invocation", targetId: "inv_aaa", relation: "produced-by" },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("renders a failure summary that includes the error message", () => {
    const workspace = setupWorkspace();
    try {
      const result = buildTaskSummaryArtifact({
        workspaceLocalPath: workspace.root,
        invocationId: "inv_fail",
        commandKind: "task.start.request",
        prompt: "Crash please",
        status: "failed",
        startedAt: "2026-05-25T00:00:00.000Z",
        completedAt: "2026-05-25T00:00:01.000Z",
        agentChunkCount: 0,
        agentTextPreview: "",
        agentTextTruncated: false,
        errorMessage: "model exploded\nstack trace continued",
      });

      const body = readFileSync(result.canonicalPath, "utf8");
      expect(body).toContain("# ⚠️ Task failed");
      expect(body).toContain("**Error**: `model exploded stack trace continued`");
      expect(body).toContain("## Failure detail");
      expect(body).toContain("model exploded");
      expect(body).toContain("_No streamed agent text captured._");
      expect(result.payload.provenance).toMatchObject({ status: "failed" });
    } finally {
      workspace.cleanup();
    }
  });

  it("omits inlineMarkdown when the canonical body exceeds the inline budget", () => {
    const workspace = setupWorkspace();
    try {
      // Build a synthetic large preview so the rendered Markdown blows past the
      // 64 KB budget.
      const big = "x".repeat(MAX_INLINE_PREVIEW_BYTES);
      const result = buildTaskSummaryArtifact({
        workspaceLocalPath: workspace.root,
        invocationId: "inv_big",
        commandKind: "task.start.request",
        prompt: "noop",
        status: "succeeded",
        startedAt: "2026-05-25T00:00:00.000Z",
        completedAt: "2026-05-25T00:00:01.000Z",
        agentChunkCount: 1,
        agentTextPreview: big,
        agentTextTruncated: false,
      });

      expect(result.payload.sizeBytes).toBeGreaterThan(MAX_INLINE_PREVIEW_BYTES);
      expect(result.payload.contentRef.inlineMarkdown).toBeUndefined();
      expect(result.payload.contentRef.runtimePathRef).toMatch(/^file:\/\//);
      // Canonical content is still on disk.
      const body = readFileSync(result.canonicalPath);
      expect(body.length).toBe(result.payload.sizeBytes);
    } finally {
      workspace.cleanup();
    }
  });
});

describe("truncateAgentText", () => {
  it("returns the original text untouched when within the byte budget", () => {
    const { preview, truncated } = truncateAgentText("hello world", 1024);
    expect(preview).toBe("hello world");
    expect(truncated).toBe(false);
  });

  it("truncates oversized text and reports it", () => {
    const huge = "y".repeat(2048);
    const { preview, truncated } = truncateAgentText(huge, 256);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(256);
  });
});
