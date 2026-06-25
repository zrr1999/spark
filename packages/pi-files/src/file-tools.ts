/**
 * read / write / edit / ls tool definitions for pi-files.
 *
 * Each factory returns a ToolConfig compatible with `pi.registerTool`. They
 * resolve the working directory from the extension context per call, so a
 * single registration works across sessions with different cwds.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ToolConfig } from "@zendev-lab/pi-extension-api";

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
import { pathExists, resolveReadPath, resolveToCwd } from "./path-utils.ts";
import {
  errorMessage,
  resolveToolCwd,
  text,
  throwIfAborted,
  type ToolExecResult,
} from "./shared.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

// ── read ────────────────────────────────────────────────────────────────

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export function createReadToolConfig(): ToolConfig {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: readSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const rawPath = stringParam(params.path);
      const offset = numberParam(params.offset);
      const limit = numberParam(params.limit);
      const absolutePath = await resolveReadPath(rawPath, cwd);
      throwIfAborted(signal);

      let buffer: Buffer;
      try {
        buffer = await readFile(absolutePath);
      } catch (error) {
        return errorResult(`Could not read file: ${rawPath}. ${errorMessage(error)}.`);
      }
      throwIfAborted(signal);

      const textContent = buffer.toString("utf-8");
      const allLines = textContent.split("\n");
      const totalFileLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        return errorResult(
          `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
        );
      }

      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent);
      let outputText: string;
      let details: Record<string, unknown> | undefined;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Read a narrower range with offset/limit.]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }

      return { content: [text(outputText)], details };
    },
  };
}

// ── write ───────────────────────────────────────────────────────────────

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteToolConfig(): ToolConfig {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: writeSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const rawPath = stringParam(params.path);
      const content = typeof params.content === "string" ? params.content : "";
      const absolutePath = resolveToCwd(rawPath, cwd);
      try {
        await mkdir(dirname(absolutePath), { recursive: true });
        throwIfAborted(signal);
        await writeFile(absolutePath, content, "utf-8");
      } catch (error) {
        return errorResult(`Could not write file: ${rawPath}. ${errorMessage(error)}.`);
      }
      return {
        content: [text(`Successfully wrote ${content.length} bytes to ${rawPath}`)],
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

      if (!(await pathExists(absolutePath))) {
        return errorResult(`Could not edit file: ${rawPath}. Error code: ENOENT.`);
      }
      throwIfAborted(signal);

      let rawContent: string;
      try {
        rawContent = (await readFile(absolutePath)).toString("utf-8");
      } catch (error) {
        return errorResult(`Could not edit file: ${rawPath}. ${errorMessage(error)}.`);
      }
      throwIfAborted(signal);

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
      try {
        await writeFile(absolutePath, finalContent, "utf-8");
      } catch (error) {
        return errorResult(`Could not edit file: ${rawPath}. ${errorMessage(error)}.`);
      }
      throwIfAborted(signal);

      const diffResult = generateDiffString(baseContent, newContent);
      const patch = generateUnifiedPatch(rawPath, baseContent, newContent);
      return {
        content: [text(`Successfully replaced ${edits.length} block(s) in ${rawPath}.`)],
        details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
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

      const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: Record<string, unknown> = {};
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

function errorResult(message: string): ToolExecResult {
  return { content: [text(message)], isError: true };
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
