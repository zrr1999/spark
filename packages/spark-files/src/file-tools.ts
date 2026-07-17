/**
 * read / write / edit / ls tool definitions for spark-files.
 *
 * Each factory returns a ToolConfig compatible with `pi.registerTool`. They
 * resolve the working directory from the extension context per call, so a
 * single registration works across sessions with different cwds.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolConfig, ToolPolicy } from "@zendev-lab/spark-extension-api";

import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type FileEdit,
} from "./edit-diff.ts";
import {
  atomicReplaceTextFile,
  createFileReadMetadata,
  isFileVersionPrecondition,
  readRegularFileSnapshot,
  type FileVersionState,
} from "./file-version.ts";
import { pathExists, resolveReadPath, resolveToCwd } from "./path-utils.ts";
import {
  errorMessage,
  resolveToolCwd,
  text,
  throwIfAborted,
  type ToolExecResult,
} from "./shared.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  joinTextLines,
  splitTextLines,
  truncateHead,
} from "./truncate.ts";

const FILE_READ_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["files"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

const FILE_WRITE_POLICY = {
  effect: "local_write",
  executionMode: "sequential",
  domains: ["files"],
  phases: ["implement"],
  approval: "none",
} as const satisfies ToolPolicy;

// ── read ────────────────────────────────────────────────────────────────

const readSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the UTF-8 text file to read (relative or absolute)",
    }),
    offset: Type.Optional(
      Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, description: "Maximum number of lines to read" }),
    ),
  },
  { additionalProperties: false },
);

export function createReadToolConfig(): ToolConfig {
  return {
    name: "read",
    label: "read",
    description: `Read a UTF-8 text file as one versioned, line-anchored snapshot. The first line contains the complete-file SHA-256 version; every returned source line uses LINE#HASH:text. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit and follow the continuation notice for large files.`,
    promptGuidelines: [
      "Use read to examine files instead of cat or sed.",
      "Read always returns a model-visible file version and LINE#HASH:text anchors. Copy the file version into write.expectedVersion; remove LINE#HASH: prefixes when composing literal write.content or edit.oldText.",
    ],
    parameters: readSchema,
    policy: FILE_READ_POLICY,
    effect: FILE_READ_POLICY.effect,
    executionMode: FILE_READ_POLICY.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const rawPath = stringParam(params.path);
      const offset = positiveIntegerParam(params.offset);
      if (params.offset !== undefined && offset === undefined) {
        return errorResult("Could not read file: offset must be a positive integer.", {
          code: "INVALID_READ_WINDOW",
          parameter: "offset",
        });
      }
      const limit = positiveIntegerParam(params.limit);
      if (params.limit !== undefined && limit === undefined) {
        return errorResult("Could not read file: limit must be a positive integer.", {
          code: "INVALID_READ_WINDOW",
          parameter: "limit",
        });
      }
      const absolutePath = await resolveReadPath(rawPath, cwd);
      throwIfAborted(signal);

      let buffer: Buffer;
      try {
        buffer = await readFile(absolutePath);
      } catch (error) {
        return errorResult(`Could not read file: ${rawPath}. ${errorMessage(error)}.`);
      }
      throwIfAborted(signal);

      let textContent: string;
      try {
        // Preserve a UTF-8 BOM in the logical first line while rejecting binary
        // or incorrectly encoded data instead of silently inserting U+FFFD.
        textContent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
      } catch {
        return errorResult(`Could not read file: ${rawPath}. File is not valid UTF-8 text.`, {
          code: "INVALID_UTF8",
        });
      }
      const lineSegments = splitTextLines(textContent);
      const allLines = lineSegments.map((line) => line.text);
      const totalFileLines = allLines.length;
      const startLine = offset === undefined ? 0 : offset - 1;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        return errorResult(
          `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
        );
      }

      let selectedLines: string[];
      let selectedSegments = lineSegments.slice(startLine);
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedLines = allLines.slice(startLine, endLine);
        selectedSegments = lineSegments.slice(startLine, endLine);
        userLimitedLines = endLine - startLine;
      } else {
        selectedLines = allLines.slice(startLine);
      }

      const selectedContent = joinTextLines(selectedSegments);
      const truncation = truncateHead(selectedContent);
      let noticeText: string | undefined;
      let details: Record<string, unknown> | undefined;
      let outputLineCount = selectedLines.length;
      let nextOffset: number | undefined;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
        noticeText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Read a narrower range with offset/limit.]`;
        details = { truncation };
        outputLineCount = 0;
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        nextOffset = endLineDisplay + 1;
        if (truncation.truncatedBy === "lines") {
          noticeText = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          noticeText = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
        details = { truncation };
        outputLineCount = truncation.outputLines;
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        nextOffset = startLine + userLimitedLines + 1;
        noticeText = `[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      }

      let metadata = createFileReadMetadata({
        buffer,
        lines: allLines,
        startLineIndex: startLine,
        outputLineCount,
        requestedLimit: limit,
        nextOffset,
      });
      let outputText = renderVersionedRead(metadata, noticeText);
      if (Buffer.byteLength(outputText, "utf8") > DEFAULT_MAX_BYTES) {
        let fittedLineCount = 0;
        let anchoredBytes = 0;
        const versionHeaderBytes = Buffer.byteLength(`[File version: ${metadata.version}]`, "utf8");
        for (let count = 1; count <= metadata.window.anchors.length; count += 1) {
          const anchor = metadata.window.anchors[count - 1];
          if (anchor === undefined) break;
          anchoredBytes += Buffer.byteLength(anchor.anchor, "utf8") + (count > 1 ? 1 : 0);
          const fittedNotice = byteLimitNotice(startLineDisplay, totalFileLines, count);
          const candidateBytes =
            versionHeaderBytes + 2 + anchoredBytes + 2 + Buffer.byteLength(fittedNotice, "utf8");
          if (candidateBytes > DEFAULT_MAX_BYTES) break;
          fittedLineCount = count;
        }

        outputLineCount = fittedLineCount;
        nextOffset = fittedLineCount > 0 ? startLine + fittedLineCount + 1 : undefined;
        noticeText =
          fittedLineCount > 0
            ? byteLimitNotice(startLineDisplay, totalFileLines, fittedLineCount)
            : `[Line ${startLineDisplay} plus its read anchor exceeds the ${formatSize(DEFAULT_MAX_BYTES)} output limit.]`;
        metadata = createFileReadMetadata({
          buffer,
          lines: allLines,
          startLineIndex: startLine,
          outputLineCount,
          requestedLimit: limit,
          nextOffset,
        });
        outputText = renderVersionedRead(metadata, noticeText);
        details = {
          truncation: {
            ...truncation,
            truncated: true,
            truncatedBy: "bytes",
            outputLines: fittedLineCount,
            outputBytes: Buffer.byteLength(outputText, "utf8"),
            firstLineExceedsLimit: fittedLineCount === 0,
          },
        };
      }
      return {
        content: [text(outputText)],
        details: { ...details, path: rawPath, ...metadata },
      };
    },
  };
}

// ── write ───────────────────────────────────────────────────────────────

const writeSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the UTF-8 text file to write (relative or absolute)",
    }),
    content: Type.String({
      description: "Complete literal UTF-8 file content without read anchors",
    }),
    expectedVersion: Type.String({
      description:
        "Required optimistic-concurrency precondition: pass the exact version returned by read, or 'missing' to create a file only if it does not exist.",
      pattern: "^(?:missing|sha256:[0-9a-f]{64})$",
    }),
  },
  { additionalProperties: false },
);

export function createWriteToolConfig(): ToolConfig {
  return {
    name: "write",
    label: "write",
    description:
      "Atomically write complete literal UTF-8 content with a required version precondition. Use the SHA-256 version returned by read to replace that exact file snapshot, or expectedVersion='missing' to create only when absent. A conflict never writes or retries implicitly.",
    promptGuidelines: [
      "Use write only for new files or complete rewrites.",
      "Every write must pass expectedVersion: use the exact version from read for an existing file, or missing for a new file.",
      "On VERSION_CONFLICT, re-read the file, rebuild the complete content against that snapshot, and retry. Never reuse a stale version.",
    ],
    parameters: writeSchema,
    policy: FILE_WRITE_POLICY,
    effect: FILE_WRITE_POLICY.effect,
    executionMode: FILE_WRITE_POLICY.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const rawPath = stringParam(params.path);
      if (typeof params.content !== "string") {
        return errorResult(`Could not write file: ${rawPath}. content must be a string.`, {
          code: "INVALID_WRITE_CONTENT",
        });
      }
      const content = params.content;
      const rawExpectedVersion = params.expectedVersion;
      if (
        typeof rawExpectedVersion !== "string" ||
        !isFileVersionPrecondition(rawExpectedVersion)
      ) {
        return errorResult(
          `Could not write file: ${rawPath}. expectedVersion is required and must be the version returned by read or 'missing'.`,
          { code: "INVALID_EXPECTED_VERSION" },
        );
      }
      const expectedVersion = rawExpectedVersion as FileVersionState;
      const absolutePath = resolveToCwd(rawPath, cwd);
      let result: Awaited<ReturnType<typeof atomicReplaceTextFile>>;
      try {
        result = await atomicReplaceTextFile(absolutePath, content, {
          expectedVersion,
          signal,
        });
      } catch (error) {
        return errorResult(`Could not write file: ${rawPath}. ${errorMessage(error)}.`);
      }
      if (!result.ok) {
        return errorResult(
          `Could not write file: ${rawPath}. File version precondition failed (expected ${result.expectedVersion}, actual ${result.actualVersion}). Re-read the file and retry.`,
          {
            code: "VERSION_CONFLICT",
            expectedVersion: result.expectedVersion,
            actualVersion: result.actualVersion,
            retry: "read_then_retry",
          },
        );
      }
      return {
        content: [
          text(
            `Successfully wrote ${result.sizeBytes} bytes to ${rawPath}\n[File version: ${result.version}]`,
          ),
        ],
        details: {
          path: rawPath,
          version: result.version,
          previousVersion: result.previousVersion,
          sizeBytes: result.sizeBytes,
          atomic: true,
        },
      };
    },
  };
}

// ── edit ────────────────────────────────────────────────────────────────

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }),
  },
  { additionalProperties: false },
);

export function createEditToolConfig(): ToolConfig {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
    parameters: editSchema,
    policy: FILE_WRITE_POLICY,
    effect: FILE_WRITE_POLICY.effect,
    executionMode: FILE_WRITE_POLICY.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const rawPath = stringParam(params.path);
      const edits = normalizeEdits(params.edits);
      if (edits.length === 0) {
        return errorResult(
          "Edit tool input is invalid. edits must contain at least one replacement.",
        );
      }
      const absolutePath = resolveToCwd(rawPath, cwd);

      let snapshot: Awaited<ReturnType<typeof readRegularFileSnapshot>>;
      try {
        snapshot = await readRegularFileSnapshot(absolutePath);
      } catch (error) {
        return errorResult(`Could not edit file: ${rawPath}. ${errorMessage(error)}.`);
      }
      throwIfAborted(signal);
      const rawBuffer = snapshot.bytes;

      let rawContent: string;
      try {
        rawContent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBuffer);
      } catch {
        return errorResult(`Could not edit file: ${rawPath}. File is not valid UTF-8 text.`, {
          code: "INVALID_UTF8",
        });
      }

      const { bom, text: content } = stripBom(rawContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      let baseContent: string;
      let newContent: string;
      try {
        ({ baseContent, newContent } = applyEditsToNormalizedContent(
          normalizedContent,
          edits,
          rawPath,
        ));
      } catch (error) {
        return errorResult(errorMessage(error));
      }

      const finalContent = bom + restoreLineEndings(newContent, originalEnding);
      let writeResult: Awaited<ReturnType<typeof atomicReplaceTextFile>>;
      try {
        writeResult = await atomicReplaceTextFile(absolutePath, finalContent, {
          expectedVersion: snapshot.version,
          signal,
        });
      } catch (error) {
        return errorResult(`Could not edit file: ${rawPath}. ${errorMessage(error)}.`);
      }
      if (!writeResult.ok) {
        return errorResult(
          `Could not edit file: ${rawPath}. File changed after it was read (expected ${writeResult.expectedVersion}, actual ${writeResult.actualVersion}). Re-read the file and retry.`,
          {
            code: "VERSION_CONFLICT",
            expectedVersion: writeResult.expectedVersion,
            actualVersion: writeResult.actualVersion,
            retry: "read_then_retry",
          },
        );
      }
      const diffResult = generateDiffString(baseContent, newContent);
      const patch = generateUnifiedPatch(rawPath, baseContent, newContent);
      return {
        content: [
          text(
            `Successfully replaced ${edits.length} block(s) in ${rawPath}.\n[File version: ${writeResult.version}]`,
          ),
        ],
        details: {
          path: rawPath,
          diff: diffResult.diff,
          patch,
          firstChangedLine: diffResult.firstChangedLine,
          version: writeResult.version,
          previousVersion: writeResult.previousVersion,
          atomic: true,
        },
      };
    },
  };
}

// ── ls ──────────────────────────────────────────────────────────────────

const lsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory to list (default: current directory)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of entries to return (default: 500)" }),
  ),
});

const LS_DEFAULT_LIMIT = 500;

export function createLsToolConfig(): ToolConfig {
  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsSchema,
    policy: FILE_READ_POLICY,
    effect: FILE_READ_POLICY.effect,
    executionMode: FILE_READ_POLICY.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const dirPath = resolveToCwd(
        typeof params.path === "string" && params.path ? params.path : ".",
        cwd,
      );
      const effectiveLimit = numberParam(params.limit) ?? LS_DEFAULT_LIMIT;

      if (!(await pathExists(dirPath))) return errorResult(`Path not found: ${dirPath}`);
      let dirStat;
      try {
        dirStat = await stat(dirPath);
      } catch (error) {
        return errorResult(`Path not found: ${dirPath}. ${errorMessage(error)}`);
      }
      if (!dirStat.isDirectory()) return errorResult(`Not a directory: ${dirPath}`);

      let entries: string[];
      try {
        const { readdir } = await import("node:fs/promises");
        entries = await readdir(dirPath);
      } catch (error) {
        return errorResult(`Cannot read directory: ${errorMessage(error)}`);
      }
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        throwIfAborted(signal);
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        let suffix = "";
        try {
          if ((await stat(join(dirPath, entry))).isDirectory()) suffix = "/";
        } catch {
          continue;
        }
        results.push(entry + suffix);
      }

      if (results.length === 0) return { content: [text("(empty directory)")] };

      const compacted = compactLsResults(results);
      const truncation = truncateHead(compacted.text, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: Record<string, unknown> = {};
      if (compacted.grouped) details.grouped = "summary";
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
        );
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return {
        content: [text(output)],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

interface CompactLsOutput {
  text: string;
  grouped: boolean;
}

const LS_COMPACT_MIN_ENTRIES = 30;
const LS_COMPACT_SAMPLE_LIMIT = 12;

function compactLsResults(entries: string[]): CompactLsOutput {
  const flat = entries.join("\n");
  if (entries.length < LS_COMPACT_MIN_ENTRIES) return { text: flat, grouped: false };

  const dirs = entries.filter((entry) => entry.endsWith("/"));
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const lines = [`entries=${entries.length} dirs=${dirs.length} files=${files.length}`];
  if (dirs.length > 0) lines.push(`dirs: ${compactLsSample(dirs)}`);
  if (files.length > 0) lines.push(`files: ${compactLsSample(files)}`);
  const grouped = lines.join("\n");
  return grouped.length < flat.length
    ? { text: grouped, grouped: true }
    : { text: flat, grouped: false };
}

function compactLsSample(entries: string[]): string {
  const visible = entries.slice(0, LS_COMPACT_SAMPLE_LIMIT);
  const hidden = entries.length - visible.length;
  return `${visible.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

function errorResult(message: string, details?: Record<string, unknown>): ToolExecResult {
  const result: ToolExecResult = { content: [text(message)], isError: true };
  if (details !== undefined) result.details = details;
  return result;
}

function renderVersionedRead(
  metadata: ReturnType<typeof createFileReadMetadata>,
  notice?: string,
): string {
  return [
    `[File version: ${metadata.version}]`,
    metadata.window.anchors.map((anchor) => anchor.anchor).join("\n"),
    notice,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

function byteLimitNotice(startLine: number, totalLines: number, lineCount: number): string {
  const endLine = startLine + lineCount - 1;
  return `[Showing lines ${startLine}-${endLine} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} output limit). Use offset=${endLine + 1} to continue.]`;
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeEdits(value: unknown): FileEdit[] {
  let raw = value;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      // fall through to validation below
    }
  }
  if (!Array.isArray(raw)) return [];
  const edits: FileEdit[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as FileEdit).oldText === "string" &&
      typeof (entry as FileEdit).newText === "string"
    ) {
      edits.push({ oldText: (entry as FileEdit).oldText, newText: (entry as FileEdit).newText });
    }
  }
  return edits;
}
