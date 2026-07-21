/**
 * Display-safe tool argument/result previews for conversation projections.
 * Raw payloads stay out of metadata; only bounded summaries are shared with hosts.
 */

const SENSITIVE_KEY =
  /(?:^|[_-])(secret|token|password|passwd|passphrase|credential|authorization|auth|api[_-]?key|access[_-]?key|private[_-]?key|signature|cookie|session)(?:[_-]|$)/iu;

const PREFERRED_ARG_KEYS = [
  "action",
  "path",
  "file",
  "filepath",
  "filename",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "cwd",
  "name",
  "ref",
  "artifactRef",
  "taskRef",
  "goal",
  "title",
  "status",
  "mode",
  "phase",
  "view",
] as const;

const MAX_ARG_SUMMARY = 160;
const MAX_RESULT_SUMMARY = 2400;

/** One-line preview of tool-call arguments for UI cards. */
export function summarizeToolCallArguments(
  value: unknown,
  maxLength = MAX_ARG_SUMMARY,
): string | undefined {
  if (!isRecord(value)) return undefined;
  const preferred: string[] = [];
  const rest: string[] = [];

  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    const rendered = renderArgValue(entry);
    if (!rendered) continue;
    const fragment = `${key}=${rendered}`;
    if ((PREFERRED_ARG_KEYS as readonly string[]).includes(key)) preferred.push(fragment);
    else rest.push(fragment);
  }

  const summary = [...preferred, ...rest].join(" ").trim();
  return boundSummary(summary, maxLength);
}

/** Bounded preview of tool-result content for UI cards. */
export function summarizeToolResultContent(
  value: unknown,
  maxLength = MAX_RESULT_SUMMARY,
): string | undefined {
  const text = toolResultText(value);
  return boundSummary(text, maxLength);
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .flatMap((part) => {
        if (!isRecord(part)) return [];
        if (part.type === "text" && typeof part.text === "string") return [part.text];
        return [];
      })
      .join("\n")
      .trim();
  }
  if (isRecord(value)) {
    if (Array.isArray(value.content)) return toolResultText(value.content);
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.message === "string") return value.message.trim();
    if (typeof value.error === "string") return value.error.trim();
  }
  return "";
}

function renderArgValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number")) {
      const joined = value.map(String).join(",");
      return joined.length > 60 ? `${joined.slice(0, 57)}…` : joined;
    }
    return `[${value.length}]`;
  }
  if (isRecord(value)) return "{…}";
  return undefined;
}

function boundSummary(value: string, maxLength: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
