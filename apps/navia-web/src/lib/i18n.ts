import en from "./i18n/en.json";
import zhCN from "./i18n/zh-CN.json";

export const locales = ["en", "zh-CN"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";
export const localeCookieName = "navia_locale";

export type AppMessages = typeof en;

const dictionaries = {
  en,
  "zh-CN": zhCN as AppMessages,
} satisfies Record<Locale, AppMessages>;

export function getDictionary(locale: Locale): AppMessages {
  return dictionaries[locale];
}

export function resolveRequestLocale(input: {
  requestedLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  return matchLocale([
    input.requestedLocale,
    input.cookieLocale,
    ...parseAcceptLanguage(input.acceptLanguage ?? null),
  ]);
}

export function getRequestDictionary(input: {
  requestedLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): AppMessages {
  return getDictionary(resolveRequestLocale(input));
}

export function parseAcceptLanguage(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));

      return {
        tag: tag.trim(),
        weight: q ? Number(q.slice(2)) : 1,
      };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.tag);
}

export function matchLocale(candidates: Iterable<string | null | undefined>): Locale {
  for (const candidate of candidates) {
    const tag = candidate?.trim().toLowerCase();
    if (!tag) {
      continue;
    }

    if (tag === "zh" || tag === "zh-cn" || tag === "zh-hans" || tag.startsWith("zh-")) {
      return "zh-CN";
    }

    if (tag === "en" || tag === "en-us" || tag.startsWith("en-")) {
      return "en";
    }
  }

  return defaultLocale;
}

export function formatRelativeTime(
  value: string | null,
  locale: Locale,
  messages: AppMessages["common"],
) {
  if (!value) {
    return messages.never;
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const deltaMs = timestamp - Date.now();
  const absMs = Math.abs(deltaMs);
  if (absMs < 60_000) {
    return messages.justNow;
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

export function statusLabel(status: string, messages: AppMessages["common"]) {
  return (
    messages.status[status as keyof AppMessages["common"]["status"]] ?? status.replaceAll("_", " ")
  );
}

export function enumLabel(
  value: string | null | undefined,
  labels: Record<string, string>,
  fallback?: string,
) {
  if (!value) {
    return fallback ?? "";
  }

  return labels[value] ?? value.replaceAll("_", " ");
}

export function formatByteSize(
  value: number | null,
  locale: Locale,
  messages: AppMessages["common"],
) {
  if (value == null) {
    return messages.unknownSize;
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
