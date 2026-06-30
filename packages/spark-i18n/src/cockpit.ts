import en from "./cockpit/en.ts";
import zhCN from "./cockpit/zh-CN.ts";
import type { SparkLocale } from "./index.ts";

export type CockpitMessages = typeof en;

export const cockpitDictionaries = {
  en,
  "zh-CN": zhCN as CockpitMessages,
} satisfies Record<SparkLocale, CockpitMessages>;

export function getCockpitDictionary(locale: SparkLocale): CockpitMessages {
  return cockpitDictionaries[locale];
}
