import { decodeKittyPrintable, parseKey } from "@zendev-lab/spark-tui/input";

import type { AskAction } from "../state/reducer.ts";
import { reduce } from "../state/reducer.ts";
import type { AskState, ExtendedOption } from "../state/state.ts";
import {
  createInitialState,
  buildExtendedOptions,
  isSubmitTab,
  getCurrentQuestion,
} from "../state/state.ts";
import type { SparkAskFlowResult, SparkAskFlowRequest, SparkAskFlowQuestion } from "../schema.ts";
import { validateSparkAskFlowRequest } from "../schema.ts";
import type { RenderTheme } from "./render.ts";
import { renderAskScreen, normalizeRenderTheme, type AskUILanguage } from "./render.ts";

/**
 * SparkAskFlowController orchestrates the interactive ask TUI.
 *
 * Usage:
 *   const controller = new SparkAskFlowController({ ... });
 *   controller.run(tui, theme, doneCallback);
 */

export interface AskFlowOptions {
  request: SparkAskFlowRequest;
  language?: AskUILanguage;
  /** Run without TUI (returns immediately with empty answers). */
  headless?: boolean;
}

export interface SparkAskTui {
  terminal?: { columns?: number };
  requestRender?: () => void;
}

export interface SparkAskView {
  render(): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export class SparkAskFlowController {
  private state: AskState;
  private questions: readonly SparkAskFlowQuestion[];
  private optionsByTab: ReadonlyArray<readonly ExtendedOption[]>;
  private options: AskFlowOptions;
  private done: ((result: SparkAskFlowResult) => void) | null = null;
  private tui: SparkAskTui | null = null;

  constructor(options: AskFlowOptions) {
    this.options = options;

    const validation = validateSparkAskFlowRequest(options.request);
    if (!validation.valid) {
      throw new Error(
        `Invalid ask request: ${validation.error}${validation.details ? ` (${validation.details})` : ""}`,
      );
    }

    this.questions = options.request.questions!;
    this.optionsByTab = this.questions.map((q) => buildExtendedOptions(q, new Map()));
    this.state = createInitialState({ questions: [...this.questions] });
  }

  run(
    tui: SparkAskTui,
    theme: RenderTheme,
    done: (result: SparkAskFlowResult) => void,
  ): SparkAskView {
    this.tui = tui;
    this.done = done;

    const renderTheme = normalizeRenderTheme(theme);

    return {
      render: () => this.renderFrame(tui, renderTheme),
      handleInput: (data: string) => {
        const normalized = normalizeAskKey(data);
        if (normalized === "backspace") {
          this.handleBackspace();
          return;
        }
        if (this.state.inputMode || this.isFocusedCustomInput()) {
          if (isInputControlKey(normalized) && this.handleKey(data, {})) return;
          const text = printableAskText(data);
          if (text && this.handleText(text)) return;
          if (this.handleKey(data, {})) return;
          return;
        }
        if (this.handleKey(data, {})) return;
        const text = printableAskText(data);
        if (text) this.handleText(text);
      },
      invalidate() {},
    };
  }

  private renderFrame(tui: SparkAskTui, theme: RenderTheme): string[] {
    return renderAskScreen({
      state: this.state,
      questions: this.questions,
      optionsByTab: this.optionsByTab,
      theme,
      width: tui?.terminal?.columns ?? 80,
      language: this.options.language ?? "en",
      title: this.options.request.title,
      context: this.options.request.context,
      mode: this.options.request.mode,
    });
  }

  /** Dispatch a key event. Returns true if consumed. */
  handleKey(keyData: string, _keybindings: unknown): boolean {
    const action = this.routeKeyDirect(keyData);
    if (!action) return false;

    return this.dispatch(action);
  }

  /** Close the active flow through the same reducer path as an explicit user cancel. */
  cancel(): boolean {
    if (!this.done) return false;
    return this.dispatch({ kind: "cancel" });
  }

  private dispatch(action: AskAction): boolean {
    const ctx = {
      questions: this.questions,
      optionsByTab: this.optionsByTab,
      mode: this.options.request.mode,
    };

    const result = reduce(this.state, action, ctx);
    this.state = result.state;

    // Execute effects
    for (const effect of result.effects) {
      if (effect.kind === "done" && this.done) {
        const done = this.done;
        this.done = null;
        done(effect.result);
        return true;
      }
      if (effect.kind === "request_rerender" && this.tui) {
        this.tui.requestRender?.();
      }
    }

    return true;
  }

  private routeKeyDirect(keyData: string): AskAction | null {
    const normalized = normalizeAskKey(keyData);

    // Global actions
    if (normalized === "ctrl+c" || normalized === "esc") {
      if (this.state.inputMode) return { kind: "commit_input" };
      if (this.state.notesVisible) return { kind: "close_notes" };
      if (isSubmitTab(this.state, this.questions)) return { kind: "cancel" };
    }

    // Input mode keys
    if (this.state.inputMode) {
      if (normalized === "enter" || normalized === "esc") return { kind: "commit_input" };
      if (isNavigationKey(normalized)) this.preserveInputDraft();
      if (normalized === "down") return { kind: "move_option", direction: 1 };
      if (normalized === "up") return { kind: "move_option", direction: -1 };
      if (normalized === "tab" || normalized === "right") return { kind: "move_tab", direction: 1 };
      if (normalized === "shift+tab" || normalized === "left")
        return { kind: "move_tab", direction: -1 };
      return null;
    }

    // Notes mode keys
    if (this.state.notesVisible) {
      if (normalized === "enter") {
        const question = getCurrentQuestion(this.state, this.questions);
        return { kind: "commit_notes", questionId: question?.id ?? "" };
      }
      if (normalized === "esc") return { kind: "close_notes" };
      return null;
    }

    // Submit tab keys
    if (isSubmitTab(this.state, this.questions)) {
      if (normalized === "shift+tab" || normalized === "left")
        return { kind: "move_tab", direction: -1 };
      if (normalized === "enter" || normalized === "1") return { kind: "submit" };
      if (normalized === "2") return { kind: "elaborate" };
      if (normalized === "3") return { kind: "cancel" };
      if (normalized === "down" || normalized === "j")
        return { kind: "move_submit_choice", direction: 1 };
      if (normalized === "up" || normalized === "k")
        return { kind: "move_submit_choice", direction: -1 };
      return null;
    }

    // Main question tab keys
    if (normalized === "enter") {
      const opts = this.optionsByTab[this.state.currentTab];
      const focused = opts?.[this.state.optionIndex];
      if (focused?.kind === "option") {
        const question = this.questions[this.state.currentTab];
        if (question.type === "multi") return { kind: "commit_multi" };
        return { kind: "select_option" };
      }
      if (focused?.kind === "other") {
        const question = this.questions[this.state.currentTab];
        if (
          this.state.customDraftsByQuestion.get(question.id)?.trim() ||
          (question.type === "freeform" && question.required !== true)
        )
          return { kind: "commit_input" };
        return { kind: "enter_input" };
      }
      return null;
    }

    if (normalized === "space") {
      const question = this.questions[this.state.currentTab];
      if (question.type === "multi") return { kind: "toggle_multi_option" };
      return null;
    }

    if (normalized === "down" || normalized === "j") return { kind: "move_option", direction: 1 };
    if (normalized === "up" || normalized === "k") return { kind: "move_option", direction: -1 };
    if (normalized === "tab" || normalized === "right") return { kind: "move_tab", direction: 1 };
    if (normalized === "shift+tab" || normalized === "left")
      return { kind: "move_tab", direction: -1 };

    // Number shortcuts
    const num = parseInt(normalized, 10);
    if (num >= 1 && num <= 9) return { kind: "apply_number_shortcut", index: num - 1 };

    // Note shortcuts
    if (normalized === "n") {
      const question = getCurrentQuestion(this.state, this.questions);
      if (question) return { kind: "enter_notes", questionId: question.id };
    }

    if (normalized.startsWith("ctrl+s")) return { kind: "move_tab", direction: "submit" };

    return null;
  }

  /** Feed a text character for input/notes editing. */
  handleText(text: string): boolean {
    if (this.state.inputMode || this.isFocusedCustomInput()) {
      this.state = { ...this.state, inputMode: true, inputDraft: this.state.inputDraft + text };
      this.tui?.requestRender?.();
      return true;
    }
    if (this.state.notesVisible) {
      this.state = { ...this.state, notesDraft: this.state.notesDraft + text };
      this.tui?.requestRender?.();
      return true;
    }
    return false;
  }

  /** Handle backspace in input/notes mode. */
  handleBackspace(): boolean {
    if (this.state.inputMode || this.isFocusedCustomInput()) {
      this.state = {
        ...this.state,
        inputMode: true,
        inputDraft: this.state.inputDraft.slice(0, -1),
      };
      this.tui?.requestRender?.();
      return true;
    }
    if (this.state.notesVisible) {
      this.state = { ...this.state, notesDraft: this.state.notesDraft.slice(0, -1) };
      this.tui?.requestRender?.();
      return true;
    }
    return false;
  }

  private preserveInputDraft(): void {
    const question = getCurrentQuestion(this.state, this.questions);
    const text = this.state.inputDraft.trim();
    if (!question) {
      this.state = { ...this.state, inputMode: false, inputDraft: "" };
      return;
    }
    const customDraftsByQuestion = new Map(this.state.customDraftsByQuestion);
    if (text) customDraftsByQuestion.set(question.id, text);
    else customDraftsByQuestion.delete(question.id);
    this.state = { ...this.state, customDraftsByQuestion, inputMode: false };
  }

  private isFocusedCustomInput(): boolean {
    if (isSubmitTab(this.state, this.questions) || this.state.notesVisible) return false;
    const focused = this.optionsByTab[this.state.currentTab]?.[this.state.optionIndex];
    return focused?.kind === "other";
  }
}

export function normalizeAskKey(key: string): string {
  return (parseKey(key) ?? key)
    .toLowerCase()
    .replace(/escape/g, "esc")
    .replace(/return/g, "enter")
    .replace(/control\+/g, "ctrl+")
    .trim();
}

function isNavigationKey(normalized: string): boolean {
  return ["up", "down", "left", "right", "tab", "shift+tab"].includes(normalized);
}

function isInputControlKey(normalized: string): boolean {
  return (
    normalized === "enter" ||
    normalized === "esc" ||
    normalized === "backspace" ||
    isNavigationKey(normalized)
  );
}

export function printableAskText(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded) return decoded;
  if (data.includes("\x1b")) return undefined;
  if (data.length === 0) return undefined;
  if (data === "\r" || data === "\n" || data === "\t" || data === "\x7f") return undefined;
  if (data.length === 1 && data < " ") return undefined;
  return data;
}
