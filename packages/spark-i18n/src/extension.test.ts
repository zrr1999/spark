import { describe, expect, it } from "vitest";
import {
  activeSparkContextStrings,
  goalContextStrings,
  goalInstructions,
  goalNotifications,
  normalizeSparkLanguage,
  sparkLanguageForProject,
  sparkSystemPromptLanguageDirective,
} from "./extension";

describe("spark extension i18n facade", () => {
  it("detects Spark project language without depending on extension host packages", () => {
    expect(sparkLanguageForProject({ project: { outputLanguage: "zh" } })).toBe("zh");
    expect(sparkLanguageForProject({ goal: { objective: "请完成迁移" } })).toBe("zh");
    expect(sparkLanguageForProject({ fallbackText: "English objective" })).toBe("en");
    expect(normalizeSparkLanguage("zh-CN")).toBe("zh");
  });

  it("renders goal notifications through spark-i18n-owned strings", () => {
    expect(goalNotifications("en").active("Ship i18n", " · Project")).toContain(
      "Spark goal active",
    );
    expect(goalNotifications("zh").active("完成 i18n", " · 项目")).toContain("Spark 目标已启动");
    expect(goalNotifications("zh").noSessionGoal).toBe("尚未设置 Spark 会话目标。");
  });

  it("keeps goal/context/instruction helpers available", () => {
    expect(goalInstructions("en").goalLine("Ship")).toBe("Goal: Ship");
    expect(goalContextStrings("zh").currentProjectLine("项目")).toBe("当前项目：项目。");
    expect(activeSparkContextStrings("en").header).toBe("Spark context:");
    expect(sparkSystemPromptLanguageDirective("zh")).toContain("project default language: zh");
  });
});
