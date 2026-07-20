/** Practical QQ Bot markdown body limit used by other C2C adapters (UTF-8 bytes). */
export const QQBOT_MARKDOWN_MAX_BYTES = 3600;

/**
 * Split markdown into UTF-8-safe chunks that prefer paragraph / line boundaries.
 * Oversized single lines still hard-split on byte boundaries.
 */
export function chunkQqbotMarkdownText(
  text: string,
  maxBytes = QQBOT_MARKDOWN_MAX_BYTES,
): string[] {
  const normalized = text.replace(/\r\n/gu, "\n").trim();
  if (!normalized) return [];
  if (utf8Bytes(normalized) <= maxBytes) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    if (utf8Bytes(remaining) <= maxBytes) {
      chunks.push(remaining);
      break;
    }
    const fitted = fitUtf8Prefix(remaining, maxBytes);
    const splitAt = pickNaturalSplit(fitted);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    const next = remaining.slice(splitAt).trimStart();
    if (!chunk) {
      // Hard-split when a single token exceeds the budget.
      chunks.push(fitted);
      remaining = remaining.slice(fitted.length).trimStart();
      continue;
    }
    chunks.push(chunk);
    remaining = next;
  }
  return chunks;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fitUtf8Prefix(value: string, maxBytes: number): string {
  let end = value.length;
  while (end > 0 && utf8Bytes(value.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

function pickNaturalSplit(candidate: string): number {
  if (!candidate) return 0;
  const paragraph = candidate.lastIndexOf("\n\n");
  if (paragraph >= Math.floor(candidate.length * 0.4)) return paragraph + 2;
  const line = candidate.lastIndexOf("\n");
  if (line >= Math.floor(candidate.length * 0.4)) return line + 1;
  const space = candidate.lastIndexOf(" ");
  if (space >= Math.floor(candidate.length * 0.4)) return space + 1;
  return candidate.length;
}
