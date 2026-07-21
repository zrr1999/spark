/**
 * Pure-JS grep / find tools for spark-files.
 *
 * No `rg`/`fd` subprocess: matching runs in-process over a gitignore-aware
 * walk, so the tools work on hosts without those binaries. Output formatting
 * (relative paths, match/result limits, byte truncation, line truncation)
 * mirrors pi-coding-agent so the native host renders identical notices.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { Type } from "typebox";
import { minimatch } from "minimatch";
import type { ToolConfig, ToolPolicy } from "@zendev-lab/spark-core";

import { walkTree } from "./gitignore-walker.ts";
import {
  errorMessage,
  resolveToolCwd,
  text,
  throwIfAborted,
  type ToolExecResult,
} from "./shared.ts";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
} from "./truncate.ts";
import { resolveToCwd } from "./path-utils.ts";

const FILE_SEARCH_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["files", "search"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

// ── grep ────────────────────────────────────────────────────────────────

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(
    Type.String({ description: "Directory or file to search (default: current directory)" }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false)" }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description: "Treat pattern as literal string instead of regex (default: false)",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: "Number of lines to show before and after each match (default: 0)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of matches to return (default: 100)" }),
  ),
});

const GREP_DEFAULT_LIMIT = 100;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createGrepToolConfig(): ToolConfig {
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    promptGuidelines: ["Use grep to search file contents instead of shell grep/rg."],
    parameters: grepSchema,
    policy: FILE_SEARCH_POLICY,
    effect: FILE_SEARCH_POLICY.effect,
    executionMode: FILE_SEARCH_POLICY.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const pattern = stringParam(params.pattern);
      const searchPath = resolveToCwd(
        typeof params.path === "string" && params.path ? params.path : ".",
        cwd,
      );
      const glob = typeof params.glob === "string" && params.glob ? params.glob : undefined;
      const ignoreCase = params.ignoreCase === true;
      const literal = params.literal === true;
      const contextValue = numberParam(params.context, 0);
      const effectiveLimit = Math.max(1, numberParam(params.limit, GREP_DEFAULT_LIMIT));

      let regex: RegExp;
      try {
        const source = literal ? escapeRegExp(pattern) : pattern;
        regex = new RegExp(source, ignoreCase ? "i" : "");
      } catch (error) {
        return errorResult(`Invalid pattern: ${errorMessage(error)}`);
      }

      let isDirectory: boolean;
      try {
        isDirectory = (await stat(searchPath)).isDirectory();
      } catch {
        return errorResult(`Path not found: ${searchPath}`);
      }

      const formatPath = (filePath: string): string => {
        if (isDirectory) {
          const rel = relative(searchPath, filePath);
          if (rel && !rel.startsWith("..")) return toPosix(rel);
        }
        return basename(filePath);
      };

      const files: string[] = [];
      if (isDirectory) {
        try {
          for await (const entry of walkTree(searchPath, { signal })) {
            if (glob && !matchesGlob(entry.relativePath, glob)) continue;
            files.push(entry.absolutePath);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          return errorResult(errorMessage(error));
        }
      } else {
        files.push(searchPath);
      }

      const outputLines: string[] = [];
      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;

      for (const filePath of files) {
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          break;
        }
        throwIfAborted(signal);
        let lines: string[];
        try {
          const content = await readFile(filePath, "utf-8");
          lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        } catch {
          continue;
        }
        const relativePath = formatPath(filePath);
        for (let i = 0; i < lines.length; i++) {
          if (matchCount >= effectiveLimit) {
            matchLimitReached = true;
            break;
          }
          if (!regex.test(lines[i] ?? "")) continue;
          matchCount += 1;
          const lineNumber = i + 1;
          if (contextValue === 0) {
            const { text: truncated, wasTruncated } = truncateLine(lines[i] ?? "");
            if (wasTruncated) linesTruncated = true;
            outputLines.push(`${relativePath}:${lineNumber}: ${truncated}`);
          } else {
            const start = Math.max(1, lineNumber - contextValue);
            const end = Math.min(lines.length, lineNumber + contextValue);
            for (let current = start; current <= end; current++) {
              const { text: truncated, wasTruncated } = truncateLine(lines[current - 1] ?? "");
              if (wasTruncated) linesTruncated = true;
              if (current === lineNumber)
                outputLines.push(`${relativePath}:${current}: ${truncated}`);
              else outputLines.push(`${relativePath}-${current}- ${truncated}`);
            }
          }
        }
      }

      if (matchCount === 0) return { content: [text("No matches found")] };

      const groupedOutput = compactGrepOutputLines(outputLines);
      const truncation = truncateHead(groupedOutput.text, {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      let output = truncation.content;
      const details: Record<string, unknown> = {};
      if (groupedOutput.grouped) details.grouped = "by_file";
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
        );
        details.linesTruncated = true;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return {
        content: [text(output)],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

// ── find ────────────────────────────────────────────────────────────────

const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (default: current directory)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

const FIND_DEFAULT_LIMIT = 1000;

export function createFindToolConfig(): ToolConfig {
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    promptGuidelines: ["Use find to locate files by glob instead of shell find/fd."],
    parameters: findSchema,
    policy: FILE_SEARCH_POLICY,
    effect: FILE_SEARCH_POLICY.effect,
    executionMode: FILE_SEARCH_POLICY.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolExecResult> {
      throwIfAborted(signal);
      const cwd = resolveToolCwd(ctx);
      const pattern = stringParam(params.pattern);
      const searchPath = resolveToCwd(
        typeof params.path === "string" && params.path ? params.path : ".",
        cwd,
      );
      const effectiveLimit = numberParam(params.limit, FIND_DEFAULT_LIMIT);

      let isDirectory: boolean;
      try {
        isDirectory = (await stat(searchPath)).isDirectory();
      } catch {
        return errorResult(`Path not found: ${searchPath}`);
      }
      if (!isDirectory) return errorResult(`Not a directory: ${searchPath}`);

      const relativized: string[] = [];
      let resultLimitReached = false;
      try {
        for await (const entry of walkTree(searchPath, { signal })) {
          if (!matchesGlob(entry.relativePath, pattern)) continue;
          relativized.push(entry.relativePath);
          if (relativized.length >= effectiveLimit) {
            resultLimitReached = true;
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        return errorResult(errorMessage(error));
      }

      if (relativized.length === 0) return { content: [text("No files found matching pattern")] };

      const groupedOutput = compactFindResults(relativized);
      const truncation = truncateHead(groupedOutput.text, {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      let output = truncation.content;
      const details: Record<string, unknown> = {};
      if (groupedOutput.grouped) details.grouped = "by_directory";
      const notices: string[] = [];
      if (resultLimitReached) {
        notices.push(
          `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
        details.resultLimitReached = effectiveLimit;
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

/**
 * Match a POSIX relative path against a find/grep glob. fd/rg match the
 * basename for patterns without a slash, and the full relative path
 * otherwise; mirror that so `*.ts` matches nested files.
 */
function matchesGlob(relativePath: string, pattern: string): boolean {
  const options = { dot: true, nocomment: true } as const;
  if (pattern.includes("/")) {
    return (
      minimatch(relativePath, pattern, options) || minimatch(relativePath, `**/${pattern}`, options)
    );
  }
  return minimatch(basename(relativePath), pattern, options);
}

const GREP_GROUP_PER_FILE_LIMIT = 8;
const FIND_GROUP_SAMPLE_LIMIT = 6;

interface GroupedOutput {
  text: string;
  grouped: boolean;
}

interface ParsedGrepLine {
  file: string;
  lineNumber: string;
  separator: ":" | "-";
  content: string;
}

function compactGrepOutputLines(lines: string[]): GroupedOutput {
  const flat = lines.join("\n");
  const groups = new Map<string, ParsedGrepLine[]>();
  const order: string[] = [];

  for (const line of lines) {
    const parsed = parseGrepOutputLine(line);
    if (!parsed) return { text: flat, grouped: false };
    if (!groups.has(parsed.file)) {
      groups.set(parsed.file, []);
      order.push(parsed.file);
    }
    groups.get(parsed.file)!.push(parsed);
  }

  if (groups.size <= 1 && lines.length <= GREP_GROUP_PER_FILE_LIMIT) {
    return { text: flat, grouped: false };
  }

  const groupedLines: string[] = [];
  for (const file of order) {
    const entries = groups.get(file)!;
    groupedLines.push(`${file} (${entries.length})`);
    const visible = entries.slice(0, GREP_GROUP_PER_FILE_LIMIT);
    for (const entry of visible) {
      groupedLines.push(
        `  ${entry.file}${entry.separator}${entry.lineNumber}${entry.separator} ${entry.content}`,
      );
    }
    const hidden = entries.length - visible.length;
    if (hidden > 0) groupedLines.push(`  +${hidden} more in ${file}`);
  }

  const grouped = groupedLines.join("\n");
  return grouped.length < flat.length
    ? { text: grouped, grouped: true }
    : { text: flat, grouped: false };
}

function parseGrepOutputLine(line: string): ParsedGrepLine | undefined {
  const match = /^(.*?)([:-])(\d+)([:-]) (.*)$/u.exec(line);
  if (!match || match[2] !== match[4]) return undefined;
  return {
    file: match[1]!,
    lineNumber: match[3]!,
    separator: match[2] as ":" | "-",
    content: match[5]!,
  };
}

function compactFindResults(paths: string[]): GroupedOutput {
  const flat = paths.join("\n");
  const groups = new Map<string, string[]>();
  const order: string[] = [];

  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : ".";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    if (!groups.has(dir)) {
      groups.set(dir, []);
      order.push(dir);
    }
    groups.get(dir)!.push(name);
  }

  if (groups.size <= 1 && paths.length <= FIND_GROUP_SAMPLE_LIMIT) {
    return { text: flat, grouped: false };
  }

  const groupedLines: string[] = [];
  for (const dir of order) {
    const names = groups.get(dir)!;
    groupedLines.push(`${dir === "." ? "." : `${dir}/`} (${names.length})`);
    const visible = names.slice(0, FIND_GROUP_SAMPLE_LIMIT);
    const hidden = names.length - visible.length;
    groupedLines.push(`  ${visible.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`);
  }

  const grouped = groupedLines.join("\n");
  return grouped.length < flat.length
    ? { text: grouped, grouped: true }
    : { text: flat, grouped: false };
}

function errorResult(message: string): ToolExecResult {
  return { content: [text(message)], isError: true };
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberParam(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
