import { describe, expect, it } from "vitest";
import { getCockpitDictionary } from "./index.ts";

function collectKeys(value: unknown, prefix = ""): string[] {
  if (value == null || typeof value !== "object") {
    return [prefix];
  }
  if (Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("Cockpit dictionaries", () => {
  it("loads Cockpit dictionaries from spark-cockpit-i18n", () => {
    const en = getCockpitDictionary("en");
    const zh = getCockpitDictionary("zh-CN");

    expect(en.common.justNow).toBe("just now");
    expect(zh.common.justNow).toBe("刚刚");
    expect(en.layout.nav.channels).toBe("Message platforms");
    expect(zh.layout.nav.channels).toBe("消息平台");
    expect(zh.layout.nav.models).toBe("模型服务商");
    expect(zh.console.nav.registration).toBe("工作空间连接");
    expect(zh.console.navGroups.daemon).toBe("守护进程");
    expect(zh.console.openCockpitSettings).toBe("控制平面设置");
    expect(zh.modelSettings.title).toBe("模型服务商");
    expect(zh.settings.enrollment.title).toBe("工作空间连接");
    expect(en.modelSettings.actions.defaultUpdated).toBe("Default model updated.");
    expect(zh.modelSettings.actions.defaultUpdated).toBe("默认模型已更新。");
  });

  it("keeps English and Chinese Cockpit dictionary key parity", () => {
    expect(collectKeys(getCockpitDictionary("zh-CN")).sort()).toEqual(
      collectKeys(getCockpitDictionary("en")).sort(),
    );
  });
});
