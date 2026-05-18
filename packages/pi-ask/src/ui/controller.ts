import type { AskAction } from "../state/reducer.ts";
import { reduce } from "../state/reducer.ts";
import type { AskState, ExtendedOption } from "../state/state.ts";
import {
  createInitialState,
  buildExtendedOptions,
  isSubmitTab,
  getCurrentQuestion,
} from "../state/state.ts";
import type { PiAskFlowResult, PiAskFlowRequest, PiAskFlowQuestion } from "../schema.ts";
import { validatePiAskFlowRequest } from "../schema.ts";
import type { RenderTheme } from "./render.ts";
import { renderAskScreen, type AskUILanguage } from "./render.ts";

/**
 * PiAskFlowController orchestrates the interactive ask TUI.
 *
 * Usage:
 *   const controller = new PiAskFlowController({ ... });
 *   controller.run(customCallbackArgs, doneCallback);
 */

export interface AskFlowOptions {
  request: PiAskFlowRequest;
  language?: AskUILanguage;
  /** Run without TUI (returns immediately with empty answers). */
  headless?: boolean;
}

export class PiAskFlowController {
  private state: AskState;
  private questions: readonly PiAskFlowQuestion[];
  private optionsByTab: ReadonlyArray<readonly ExtendedOption[]>;
  private options: AskFlowOptions;
  private done: ((result: PiAskFlowResult) => void) | null = null;
  private tui: any = null;

  constructor(options: AskFlowOptions) {
    this.options = options;

    const validation = validatePiAskFlowRequest(options.request);
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
    tui: any,
    theme: RenderTheme,
    done: (result: PiAskFlowResult) => void,
  ): { render(): string[]; invalidate(): void } {
    this.tui = tui;
    this.done = done;

    return {
      render: () => this.renderFrame(tui, theme),
      invalidate() {},
    };
  }

  private renderFrame(tui: any, theme: RenderTheme): string[] {
    return renderAskScreen({
      state: this.state,
      questions: this.questions,
      optionsByTab: this.optionsByTab,
      theme,
      width: tui?.terminal?.columns ?? 80,
      language: this.options.language ?? "en",
      title: this.options.request.title,
      context: this.options.request.context,
    });
  }

  /** Dispatch a key event. Returns true if consumed. */
  handleKey(keyData: string, _keybindings: unknown): boolean {
    // Simplified key routing for now
    const action = this.routeKeyDirect(keyData);
    if (!action) return false;

    const ctx = {
      questions: this.questions,
      optionsByTab: this.optionsByTab,
    };

    const result = reduce(this.state, action, ctx);
    this.state = result.state;

    // Execute effects
    for (const effect of result.effects) {
      if (effect.kind === "done" && this.done) {
        this.done(effect.result);
        return true;
      }
      if (effect.kind === "request_rerender" && this.tui) {
        this.tui.requestRender?.();
      }
    }

    return true;
  }

  private routeKeyDirect(keyData: string): AskAction | null {
    const normalized = normalizeKey(keyData);

    // Global actions
    if (normalized === "ctrl+c" || normalized === "esc") {
      if (this.state.settingsOpen) return { kind: "close_settings" };
      if (this.state.inputMode) return { kind: "commit_input" };
      if (this.state.notesVisible) return { kind: "close_notes" };
      if (isSubmitTab(this.state, this.questions)) return { kind: "cancel" };
    }

    if (normalized === "?" && !this.state.inputMode && !this.state.notesVisible) {
      if (this.state.settingsOpen) return { kind: "close_settings" };
      return { kind: "open_settings" };
    }

    // Settings modal keys
    if (this.state.settingsOpen) {
      if (normalized === "down") return { kind: "move_option", direction: 1 };
      if (normalized === "up") return { kind: "move_option", direction: -1 };
      return null;
    }

    // Input mode keys
    if (this.state.inputMode) {
      if (normalized === "enter") return { kind: "commit_input" };
      // Text input is accumulated elsewhere
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
      if (focused?.kind === "next") return { kind: "commit_multi" };
      if (focused?.kind === "option") {
        const question = this.questions[this.state.currentTab];
        if (question.type === "multi") return { kind: "toggle_multi_option" };
        return { kind: "select_option" };
      }
      if (focused?.kind === "other") return { kind: "enter_input" };
      if (focused?.kind === "chat") return { kind: "enter_chat" };
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
    if (this.state.inputMode) {
      this.state = { ...this.state, inputDraft: this.state.inputDraft + text };
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
    if (this.state.inputMode) {
      this.state = { ...this.state, inputDraft: this.state.inputDraft.slice(0, -1) };
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
}

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/escape/g, "esc")
    .replace(/return/g, "enter")
    .replace(/control\+/g, "ctrl+")
    .trim();
}
