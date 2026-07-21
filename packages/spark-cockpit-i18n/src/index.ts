import type { SparkLocale } from "@zendev-lab/spark-i18n";
import en from "./en.ts";
import zhCN from "./zh-CN.ts";

export type CockpitMessages = typeof en;

export const cockpitDictionaries = {
  en,
  "zh-CN": zhCN as CockpitMessages,
} satisfies Record<SparkLocale, CockpitMessages>;

export function getCockpitDictionary(locale: SparkLocale): CockpitMessages {
  return cockpitDictionaries[locale];
}
