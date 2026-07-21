import { m } from "./paraglide/messages.js";

export const locales = ["en", "zh-CN"] as const;
export type SparkLocale = (typeof locales)[number];

export type SparkLanguage = "en" | "zh";

export const defaultLocale: SparkLocale = "en";
export const defaultLanguage: SparkLanguage = "en";

export { m as sparkMessages };

export interface SparkLocaleRequest {
  requestedLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
  fallback?: SparkLocale;
}

export interface SparkCommonMessages {
  never: string;
  justNow: string;
  unknownSize: string;
  status: Record<string, string>;
}

export interface SparkDictionary {
  common: SparkCommonMessages;
}

const statusMessageKeys = {
  ready: "status_ready",
  pending: "status_pending",
  queued: "status_queued",
  running: "status_running",
  blocked: "status_blocked",
  done: "status_done",
  completed: "status_completed",
  failed: "status_failed",
  cancelled: "status_cancelled",
  canceled: "status_cancelled",
  rejected: "status_rejected",
  acked: "status_acked",
} as const;

type MessageKey = keyof typeof m;
type GeneratedMessage = (
  params?: Record<string, unknown>,
  options?: { locale?: SparkLocale },
) => string;

export function parseAcceptLanguage(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;

      return {
        tag: tag.trim(),
        weight: Number.isFinite(weight) ? weight : 0,
      };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((left, right) => right.weight - left.weight)
    .map((entry) => entry.tag);
}

export function matchLocale(
  candidates: Iterable<string | null | undefined>,
  fallback = defaultLocale,
): SparkLocale {
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) {
      return locale;
    }
  }

  return fallback;
}

export function resolveRequestLocale(input: SparkLocaleRequest): SparkLocale {
  return matchLocale(
    [
      input.requestedLocale,
      input.cookieLocale,
      ...parseAcceptLanguage(input.acceptLanguage ?? null),
    ],
    input.fallback ?? defaultLocale,
  );
}

export function normalizeLocale(value: unknown): SparkLocale | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const tag = value.trim().toLowerCase();
  if (!tag) {
    return undefined;
  }

  if (tag === "zh" || tag === "zh-cn" || tag === "zh-hans" || tag.startsWith("zh-")) {
    return "zh-CN";
  }

  if (tag === "en" || tag === "en-us" || tag.startsWith("en-")) {
    return "en";
  }

  return undefined;
}

export function languageToLocale(language: SparkLanguage): SparkLocale {
  return language === "zh" ? "zh-CN" : "en";
}

export function localeToLanguage(locale: SparkLocale): SparkLanguage {
  return locale === "zh-CN" ? "zh" : "en";
}

export function normalizeSparkLanguage(value: unknown): SparkLanguage | undefined {
  if (value === "en" || value === "zh") {
    return value;
  }
  const locale = normalizeLocale(value);
  return locale ? localeToLanguage(locale) : undefined;
}

export function detectSparkLanguage(
  text: string | null | undefined,
  fallback: SparkLanguage = defaultLanguage,
): SparkLanguage {
  if (!text) {
    return fallback;
  }
  return /[\u3400-\u9fff]/.test(text) ? "zh" : fallback;
}

export function message(key: MessageKey, locale: SparkLocale = defaultLocale): string {
  return callMessage(m[key], locale);
}

export function getDictionary(locale: SparkLocale = defaultLocale): SparkDictionary {
  return {
    common: getCommonMessages(locale),
  };
}

export function getCommonMessages(locale: SparkLocale = defaultLocale): SparkCommonMessages {
  return {
    never: message("relative_never", locale),
    justNow: message("relative_just_now", locale),
    unknownSize: message("size_unknown", locale),
    status: Object.fromEntries(
      Object.entries(statusMessageKeys).map(([status, key]) => [status, message(key, locale)]),
    ),
  };
}

export function statusLabel(
  status: string,
  locale: SparkLocale = defaultLocale,
  labels?: Record<string, string>,
) {
  return labels?.[status] ?? getCommonMessages(locale).status[status] ?? humanizeIdentifier(status);
}

export function enumLabel(
  value: string | null | undefined,
  labels: Record<string, string>,
  fallback?: string,
) {
  if (!value) {
    return fallback ?? "";
  }

  return labels[value] ?? humanizeIdentifier(value);
}

export function formatRelativeTime(value: string | null, locale: SparkLocale = defaultLocale) {
  const common = getCommonMessages(locale);
  if (!value) {
    return common.never;
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const deltaMs = timestamp - Date.now();
  const absMs = Math.abs(deltaMs);
  if (absMs < 60_000) {
    return common.justNow;
  }

  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  });

  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 60) {
    return formatter.format(minutes, "minute");
  }

  const hours = Math.round(deltaMs / 3_600_000);
  if (Math.abs(hours) < 24) {
    return formatter.format(hours, "hour");
  }

  const days = Math.round(deltaMs / 86_400_000);
  if (Math.abs(days) < 7) {
    return formatter.format(days, "day");
  }

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function formatByteSize(value: number | null, locale: SparkLocale = defaultLocale) {
  if (value == null) {
    return message("size_unknown", locale);
  }

  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  });

  if (value < 1024) {
    return `${formatter.format(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${formatter.format(value / 1024)} KB`;
  }
  return `${formatter.format(value / 1024 / 1024)} MB`;
}

function callMessage(fn: unknown, locale: SparkLocale): string {
  return (fn as GeneratedMessage)({}, { locale });
}

function humanizeIdentifier(value: string) {
  return value.replaceAll("_", " ");
}
