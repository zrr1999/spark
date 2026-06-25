/**
 * Shared truncation utilities for file tool outputs.
 *
 * Truncation is governed by two independent limits — whichever is hit first
 * wins: a line limit (default 2000) and a byte limit (default 50KB). Head
 * truncation never returns a partial line.
 *
 * This mirrors pi-coding-agent's `core/tools/truncate` behaviour so the Spark
 * native host renders identical continuation notices, but it depends on
 * nothing outside Node.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export type TruncatedBy = "lines" | "bytes" | null;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: TruncatedBy;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** Format bytes as a short human-readable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Truncate content from the head (keep the first N lines/bytes). Suitable for
 * file reads. Never returns a partial line; if the first line alone exceeds
 * the byte limit it returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = byteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const firstLineBytes = byteLength(lines[0] ?? "");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: TruncatedBy = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i] ?? "";
    const lineBytes = byteLength(line) + (i > 0 ? 1 : 0); // +1 for newline
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: byteLength(outputContent),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * Truncate a single line to a maximum number of characters, adding a
 * `... [truncated]` suffix. Used for grep match lines.
 */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
