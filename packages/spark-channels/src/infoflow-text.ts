/**
 * Infoflow streaming cards truncate with `text.slice(-MAX)` in the official SDK
 * (`MAX_CARD_TEXT_LENGTH = 6000` characters). This limit belongs to card
 * updates only; the installed SDK does not document the same bound for ordinary
 * messages.
 */
export const INFOFLOW_MAX_CARD_TEXT_LENGTH = 6_000;

/**
 * Split text into character-safe chunks that prefer paragraph / line boundaries.
 * Matches the SDK's `String.length` budget (not UTF-8 bytes).
 */
export function chunkInfoflowText(
  text: string,
  maxChars = INFOFLOW_MAX_CARD_TEXT_LENGTH,
): string[] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error("infoflow chunk maxChars must be a positive finite number");
  }
  const normalized = text.replace(/\r\n/gu, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    const fitted = remaining.slice(0, maxChars);
    const splitAt = pickNaturalSplit(fitted);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    const next = remaining.slice(splitAt).trimStart();
    if (!chunk) {
      chunks.push(fitted);
      remaining = remaining.slice(fitted.length).trimStart();
      continue;
    }
    chunks.push(chunk);
    remaining = next;
  }
  return chunks;
}

function pickNaturalSplit(candidate: string): number {
  if (!candidate) return 0;
  const paragraph = candidate.lastIndexOf("\n\n");
  if (paragraph >= Math.floor(candidate.length * 0.4)) return paragraph + 2;
  const line = candidate.lastIndexOf("\n");
  if (line >= Math.floor(candidate.length * 0.4)) return line + 1;
  // Prefer breaking before an unmatched markdown emphasis run. Splitting at
  // the last marker unconditionally can choose a closing `**` and turn an
  // otherwise complete bold span into malformed Markdown.
  const boldMarkers = [...candidate.matchAll(/\*\*/gu)];
  const openBold = boldMarkers.length % 2 === 1 ? boldMarkers.at(-1)?.index : undefined;
  if (openBold !== undefined && openBold >= Math.floor(candidate.length * 0.4)) return openBold;
  return candidate.length;
}
