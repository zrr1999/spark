import {
  enumLabel,
  formatByteSize as sharedFormatByteSize,
  formatRelativeTime as sharedFormatRelativeTime,
  getCockpitDictionary,
  matchLocale,
  parseAcceptLanguage,
  resolveRequestLocale,
  type CockpitMessages,
  type SparkLocale,
} from "@zendev-lab/spark-i18n";

export const locales = ["en", "zh-CN"] as const;
export type Locale = SparkLocale;

export const defaultLocale: Locale = "en";
export const localeCookieName = "spark_cockpit_locale";

export type AppMessages = CockpitMessages;

export function getDictionary(locale: Locale): AppMessages {
  return getCockpitDictionary(locale);
}

export function getRequestDictionary(input: {
  requestedLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): AppMessages {
  return getDictionary(resolveRequestLocale(input));
}

export { enumLabel, matchLocale, parseAcceptLanguage, resolveRequestLocale };

export function formatRelativeTime(
  value: string | null,
  locale: Locale,
  _messages?: AppMessages["common"],
) {
  return sharedFormatRelativeTime(value, locale);
}

export function formatByteSize(
  value: number | null,
  locale: Locale,
  _messages?: AppMessages["common"],
) {
  return sharedFormatByteSize(value, locale);
}

export function statusLabel(status: string, messages: AppMessages["common"]) {
  return (
    messages.status[status as keyof AppMessages["common"]["status"]] ?? status.replaceAll("_", " ")
  );
}
