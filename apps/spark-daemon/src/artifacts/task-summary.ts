import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createId, type ArtifactProjectionPayload } from "@zendev-lab/navia-protocol";

/**
 * Maximum byte size for an inline preview embedded in a daemon-produced
 * artifact projection. Larger artifacts are projected by `runtimePathRef`
 * only and the server is responsible for marking the preview as too large
 * (see `apps/web/src/lib/server/artifact-cache.ts`).
 */
export const MAX_INLINE_PREVIEW_BYTES = 64 * 1024;

export interface TaskSummaryInput {
  workspaceLocalPath: string;
  invocationId: string;
  /** Server command id, when available, for traceability. */
  commandId?: string | undefined;
  commandKind: string;
  commandTitle?: string | undefined;
  prompt: string;
  status: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  /** Number of streamed agent log chunks observed during the run. */
  agentChunkCount: number;
  /** Joined preview of the streamed agent text (head, possibly truncated). */
  agentTextPreview: string;
  agentTextTruncated: boolean;
  errorMessage?: string | undefined;
}

export interface TaskSummaryArtifact {
  payload: ArtifactProjectionPayload;
  /** Absolute filesystem path of the canonical Markdown artifact. */
  canonicalPath: string;
  /** UTF-8 bytes of the artifact content. */
  body: Buffer;
}

/**
 * Build and persist a canonical Markdown task summary for a daemon-executed
 * `task.start.request`. The daemon owns the canonical content under
 * `<workspace>/.navia/artifacts/<invocationId>/task-summary.md`; the returned
 * `payload` carries enough metadata for the server to project, lazily cache,
 * and preview the artifact.
 */
export function buildTaskSummaryArtifact(input: TaskSummaryInput): TaskSummaryArtifact {
  const body = renderTaskSummaryMarkdown(input);
  const canonicalPath = canonicalArtifactPath(input.workspaceLocalPath, input.invocationId);
  mkdirSync(dirname(canonicalPath), { recursive: true });
  writeFileSync(canonicalPath, body, { encoding: "utf8" });

  const sizeBytes = Buffer.byteLength(body);
  const hash = createHash("sha256").update(body).digest("hex");
  const fileUrl = pathToFileURL(canonicalPath).toString();

  const inlineMarkdown = sizeBytes <= MAX_INLINE_PREVIEW_BYTES ? body : undefined;
  const contentRef: Record<string, unknown> = {
    runtimePathRef: fileUrl,
  };
  if (inlineMarkdown !== undefined) {
    contentRef.inlineMarkdown = inlineMarkdown;
  }

  const payload: ArtifactProjectionPayload = {
    artifactId: createId("art"),
    scope: "workspace",
    kind: "task-summary",
    title: `Task summary · ${input.commandTitle ?? input.commandKind}`,
    format: "markdown",
    source: "runtime",
    hash,
    sizeBytes,
    mime: "text/markdown; charset=utf-8",
    contentRef,
    contentAvailability: {
      hash,
      mime: "text/markdown; charset=utf-8",
      sizeBytes,
      runnerAvailable: true,
    },
    provenance: {
      runtimeInvocationId: input.invocationId,
      commandKind: input.commandKind,
      commandId: input.commandId,
      commandTitle: input.commandTitle,
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      agentChunkCount: input.agentChunkCount,
    },
    links: [
      {
        targetKind: "invocation",
        targetId: input.invocationId,
        relation: "produced-by",
      },
    ],
  };

  return { payload, canonicalPath, body: Buffer.from(body, "utf8") };
}

function canonicalArtifactPath(workspaceLocalPath: string, invocationId: string): string {
  return join(
    workspaceLocalPath,
    ".navia",
    "artifacts",
    safeSegment(invocationId),
    "task-summary.md",
  );
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_") || "artifact";
}

function renderTaskSummaryMarkdown(input: TaskSummaryInput): string {
  const lines: string[] = [];
  const heading = input.status === "succeeded" ? "✅ Task succeeded" : "⚠️ Task failed";
  lines.push(`# ${heading}`, "");
  lines.push(`- **Invocation**: \`${input.invocationId}\``);
  if (input.commandId) {
    lines.push(`- **Command**: \`${input.commandId}\` (${input.commandKind})`);
  } else {
    lines.push(`- **Command kind**: \`${input.commandKind}\``);
  }
  if (input.commandTitle) {
    lines.push(`- **Title**: ${input.commandTitle}`);
  }
  lines.push(`- **Started at**: ${input.startedAt}`);
  lines.push(`- **Completed at**: ${input.completedAt}`);
  lines.push(`- **Agent log chunks**: ${input.agentChunkCount}`);
  if (input.status === "failed" && input.errorMessage) {
    lines.push(`- **Error**: \`${truncateSingleLine(input.errorMessage, 240)}\``);
  }
  lines.push("");

  lines.push("## Prompt", "", "```text", normalizeForCodeFence(input.prompt), "```", "");

  if (input.agentTextPreview.trim().length > 0) {
    lines.push("## Agent output (preview)", "");
    lines.push("```text", normalizeForCodeFence(input.agentTextPreview), "```", "");
    if (input.agentTextTruncated) {
      lines.push(
        "_Agent output truncated; full streamed log is preserved in invocation log chunks._",
        "",
      );
    }
  } else {
    lines.push("## Agent output (preview)", "", "_No streamed agent text captured._", "");
  }

  if (input.status === "failed" && input.errorMessage) {
    lines.push(
      "## Failure detail",
      "",
      "```text",
      normalizeForCodeFence(input.errorMessage),
      "```",
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

function normalizeForCodeFence(text: string): string {
  // Strip code-fence sequences so the artifact stays as a single fenced block.
  return text.replace(/```/g, "``\u2060`");
}

function truncateSingleLine(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

/**
 * Trim streamed agent text to a head preview without cutting in the middle of
 * a multi-byte sequence; used by the daemon to stay below the protocol-side
 * inline-preview budget when assembling a task summary.
 */
export function truncateAgentText(
  full: string,
  maxBytes = MAX_INLINE_PREVIEW_BYTES - 4 * 1024,
): { preview: string; truncated: boolean } {
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return { preview: full, truncated: false };
  }
  const buffer = Buffer.from(full, "utf8").subarray(0, maxBytes);
  // Decode with replacement to avoid invalid UTF-8 boundary, then drop the
  // replacement character if it appears at the tail.
  let decoded = buffer.toString("utf8");
  if (decoded.endsWith("\uFFFD")) {
    decoded = decoded.slice(0, -1);
  }
  return { preview: decoded, truncated: true };
}
