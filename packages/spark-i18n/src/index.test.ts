import { describe, expect, it } from "vitest";
import { sparkCliDispatcherStrings, sparkNativeTuiStrings, sparkTuiCliStrings } from "./cli";
import {
  defaultLocale,
  detectSparkLanguage,
  enumLabel,
  formatByteSize,
  formatRelativeTime,
  getCockpitDictionary,
  getCommonMessages,
  getDictionary,
  languageToLocale,
  localeToLanguage,
  matchLocale,
  message,
  normalizeLocale,
  normalizeSparkLanguage,
  parseAcceptLanguage,
  resolveRequestLocale,
  sparkMessages,
  statusLabel,
  type SparkLocale,
} from "./index";

describe("spark-i18n locale helpers", () => {
  it("matches supported locale tags and falls back to English", () => {
    expect(defaultLocale).toBe("en");
    expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBeUndefined();
    expect(matchLocale(["fr-FR", "zh-TW"])).toBe("zh-CN");
    expect(matchLocale([null, "fr-FR"])).toBe("en");
  });

  it("parses weighted Accept-Language candidates", () => {
    expect(parseAcceptLanguage("fr;q=0.1, zh-CN;q=0.9, en;q=0.5")).toEqual(["zh-CN", "en", "fr"]);
    expect(
      resolveRequestLocale({
        requestedLocale: null,
        cookieLocale: "fr-FR",
        acceptLanguage: "zh-Hans;q=0.8,en;q=0.7",
      }),
    ).toBe("zh-CN");
  });

  it("maps legacy Spark language values to locales", () => {
    expect(languageToLocale("zh")).toBe("zh-CN");
    expect(localeToLanguage("zh-CN")).toBe("zh");
    expect(normalizeSparkLanguage("zh-CN")).toBe("zh");
    expect(normalizeSparkLanguage("en")).toBe("en");
    expect(detectSparkLanguage("需要中文", "en")).toBe("zh");
    expect(detectSparkLanguage("English text", "en")).toBe("en");
  });
});

function collectKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") {
    return [prefix];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectKeys(item, `${prefix}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("spark-i18n messages and formatting", () => {
  it("exposes generated Paraglide messages through stable exports", () => {
    expect(typeof sparkMessages.status_ready).toBe("function");
    expect(message("status_ready", "en")).toBe("Ready");
    expect(message("status_ready", "zh-CN")).toBe("就绪");
  });

  it("builds common dictionaries with status labels", () => {
    const en = getDictionary("en");
    const zh = getDictionary("zh-CN");

    expect(en.common.status.running).toBe("Running");
    expect(zh.common.status.running).toBe("运行中");
    expect(getCommonMessages("zh-CN").unknownSize).toBe("大小未知");
  });

  it("formats status and enum labels with fallback humanization", () => {
    expect(statusLabel("running", "zh-CN")).toBe("运行中");
    expect(statusLabel("custom_state", "en")).toBe("custom state");
    expect(statusLabel("custom", "en", { custom: "Custom label" })).toBe("Custom label");
    expect(enumLabel("needs_review", {})).toBe("needs review");
    expect(enumLabel(null, {}, "n/a")).toBe("n/a");
  });

  it("formats relative times and byte sizes", () => {
    expect(formatRelativeTime(null, "en")).toBe("never");
    expect(formatRelativeTime(new Date().toISOString(), "zh-CN")).toBe("刚刚");
    expect(formatByteSize(null, "zh-CN")).toBe("大小未知");
    expect(formatByteSize(1536, "en")).toBe("1.5 KB");
  });

  it("keeps locale type import usable", () => {
    const locale: SparkLocale = "zh-CN";
    expect(locale).toBe("zh-CN");
  });
});

describe("CLI/TUI strings", () => {
  it("exposes entry strings from the shared package", () => {
    expect(sparkCliDispatcherStrings().helpText).toContain("spark - Spark command dispatcher");
    expect(sparkCliDispatcherStrings("zh").unknownSubcommand("foo", ["foo"])).toContain(
      "未知 spark 子命令",
    );
    expect(sparkTuiCliStrings().helpText).toContain("spark-tui - Spark terminal UI");
    expect(sparkTuiCliStrings().helpText).toContain("zellij --session spark");
    expect(sparkTuiCliStrings().helpText).toContain("spark daemon session list --json");
    expect(sparkTuiCliStrings().helpText).toContain("--session-id <session-id>");
    expect(sparkTuiCliStrings().helpText).toContain("workspace-bound");
    expect(sparkTuiCliStrings("zh").noModelsRegistered).toContain("尚未注册 Spark 模型");
    expect(sparkNativeTuiStrings().commandHelp(0, [])).toContain("Spark native TUI commands");
    expect(sparkNativeTuiStrings("zh").emptyCommand).toContain("空命令");
  });
});

describe("Cockpit dictionaries", () => {
  it("loads Cockpit dictionaries from spark-i18n", () => {
    expect(getCockpitDictionary("en").common.justNow).toBe("just now");
    expect(getCockpitDictionary("zh-CN").common.justNow).toBe("刚刚");
  });

  it("keeps English and Chinese Cockpit dictionary key parity", () => {
    expect(collectKeys(getCockpitDictionary("zh-CN")).sort()).toEqual(
      collectKeys(getCockpitDictionary("en")).sort(),
    );
  });
});
