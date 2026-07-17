const DEFAULT_MAX_DISPLAY_ERROR_CHARS = 1_000;

/**
 * Convert an upstream/runtime failure into bounded display-safe text.
 *
 * Proxies sometimes put a short status before a complete HTML error document.
 * Preserve that status and the document title, but never project the page body
 * (scripts, styles, SVGs, request diagnostics) into a session transcript.
 */
export function sanitizeSparkDisplayError(
  value: unknown,
  options: { fallback?: string; maxChars?: number } = {},
): string {
  const fallback = normalizeErrorText(options.fallback ?? "");
  if (typeof value !== "string" || !value.trim()) return fallback;

  const raw = value.trim();
  const firstDocumentTag = raw.search(/<(?:!doctype|html|head|body|title|style|script|svg)\b/iu);
  const prefix = normalizeErrorText(firstDocumentTag >= 0 ? raw.slice(0, firstDocumentTag) : raw);
  const titleMatch = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const title = titleMatch ? normalizeErrorText(titleMatch[1] ?? "") : "";
  const summary =
    [prefix, title]
      .filter(Boolean)
      .filter((part, index, values) => values.indexOf(part) === index)
      .join(" — ") ||
    (firstDocumentTag < 0 ? normalizeErrorText(raw) : "") ||
    fallback;
  if (!summary) return "";

  const requestedMax = options.maxChars ?? DEFAULT_MAX_DISPLAY_ERROR_CHARS;
  const maxChars = Number.isFinite(requestedMax)
    ? Math.max(1, Math.floor(requestedMax))
    : DEFAULT_MAX_DISPLAY_ERROR_CHARS;
  return summary.length <= maxChars ? summary : `${summary.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeErrorText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}
