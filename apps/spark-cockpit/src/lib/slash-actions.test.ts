import { getCockpitDictionary } from "@zendev-lab/spark-i18n";
import { sparkSlashActionBarForInput } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import {
  cockpitComposerFeedbackAfterInput,
  cockpitOpenSearchEvent,
  cockpitSlashCatalogActionBarForInput,
  cockpitSlashSuggestionsForInput,
  cockpitSlashSubmissionError,
  localizeCockpitSlashActionBar,
  scheduleCockpitActionAfterCurrentEvent,
} from "./slash-actions";

describe("Cockpit slash action presentation", () => {
  it("clears stale composer feedback without disturbing an active submission", () => {
    expect(cockpitComposerFeedbackAfterInput("error")).toEqual({
      state: "idle",
      clearFeedback: true,
    });
    expect(cockpitComposerFeedbackAfterInput("success")).toEqual({
      state: "idle",
      clearFeedback: true,
    });
    expect(cockpitComposerFeedbackAfterInput("idle")).toEqual({
      state: "idle",
      clearFeedback: true,
    });
    expect(cockpitComposerFeedbackAfterInput("submitting")).toEqual({
      state: "submitting",
      clearFeedback: false,
    });
  });

  it("defers dialog actions until the selecting click has completed", () => {
    const scheduled: Array<() => void> = [];
    let open = false;

    scheduleCockpitActionAfterCurrentEvent(
      () => {
        open = true;
      },
      (callback) => scheduled.push(callback),
    );

    expect(open).toBe(false);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(open).toBe(true);
  });

  it("localizes protocol presentation copy without changing semantic intents", () => {
    const source = sparkSlashActionBarForInput("/model");
    if (!source) throw new Error("Missing model action bar");

    const localized = localizeCockpitSlashActionBar(
      source,
      getCockpitDictionary("zh-CN").sessions.workbench.slashActions,
    );

    expect(localized).toMatchObject({
      id: "model",
      title: "模型控制",
      description: "选择当前模型，或查看已配置的模型服务商。",
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "select-model",
          label: "选择模型",
          intent: "model.select",
        }),
        expect.objectContaining({
          id: "choose-thinking",
          label: "推理强度",
          intent: "thinking.select",
        }),
      ]),
    });
  });

  it("presents localized slash completions without duplicating aliases", () => {
    const messages = getCockpitDictionary("zh-CN").sessions.workbench.slashActions;
    const initial = cockpitSlashSuggestionsForInput("/", messages);

    expect(initial.map((suggestion) => suggestion.command)).toContain("session");
    expect(initial.map((suggestion) => suggestion.command)).not.toContain("sessions");
    expect(initial.find((suggestion) => suggestion.command === "model")).toMatchObject({
      canonicalCommand: "model",
      title: "模型控制",
      description: "选择当前模型，或查看已配置的模型服务商。",
    });

    expect(cockpitSlashSuggestionsForInput("/res", messages)).toEqual([
      expect.objectContaining({
        command: "resume",
        canonicalCommand: "session",
        title: "会话控制",
      }),
    ]);
    expect(cockpitSlashSuggestionsForInput("/sessions", messages)).toEqual([]);
    expect(cockpitSlashSuggestionsForInput("//sessions", messages)).toEqual([]);
  });

  it("recognizes catalog commands with arguments for the submission guard", () => {
    expect(cockpitSlashCatalogActionBarForInput("/model baidu-oneapi/gpt-5.6-sol")?.id).toBe(
      "model",
    );
    expect(cockpitSlashCatalogActionBarForInput("/goal restart")?.id).toBe("goal");
    expect(cockpitSlashCatalogActionBarForInput("/not-a-spark-command value")).toBeUndefined();
  });

  it("returns a localized server fallback and a stable search event", () => {
    const messages = getCockpitDictionary("zh-CN").sessions.workbench.slashActions;

    expect(cockpitSlashSubmissionError("/help anything", messages)).toBe(
      "请使用输入框上方的“Spark 帮助”操作栏；这条 slash 命令没有发送给模型。",
    );
    for (const input of ["/clear", "/compact", "/new", "/runs now"]) {
      expect(cockpitSlashSubmissionError(input, messages)).toContain("没有发送给模型");
    }
    expect(cockpitSlashSubmissionError("/definitely-not-a-spark-command", messages)).toContain(
      "尚不识别或不支持",
    );
    expect(cockpitSlashSubmissionError("//clear", messages)).toBeNull();
    expect(cockpitOpenSearchEvent).toBe("spark-cockpit:open-search");
  });
});
