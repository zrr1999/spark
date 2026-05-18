import type { PiAskFlowOption, PiAskFlowQuestion, PiAskFlowAnswerEntry } from "../schema.ts";

/**
 * Canonical UI state for the ask dialog. Single source of truth —
 * both dispatch (key-router) and the view layer read this same shape.
 */
export interface AskState {
  /** Currently focused tab (question index, or -1 for submit tab). */
  currentTab: number;
  /** Focused option index within the current question's options list (including sentinels). */
  optionIndex: number;
  /** Whether the user is in the free-text input editor. */
  inputMode: boolean;
  /** Whether the notes editor is visible for the focused option. */
  notesVisible: boolean;
  /** Whether chat row is focused (redirect to conversation). */
  chatFocused: boolean;
  /** Collected answers, keyed by question id. */
  answers: ReadonlyMap<string, PiAskFlowAnswerEntry>;
  /** Multi-select checked option values for the current question. */
  multiSelectChecked: ReadonlySet<string>;
  /** Pre-submit notes for each question, keyed by question id. */
  notesByQuestion: ReadonlyMap<string, string>;
  /** Whether the focused option has a non-empty preview. */
  focusedOptionHasPreview: boolean;
  /** Focused row in the submit-tab picker (0 = Submit, 1 = Elaborate, 2 = Cancel). */
  submitChoiceIndex: number;
  /** Current draft in the free-text editor. */
  inputDraft: string;
  /** Current draft in the notes editor. */
  notesDraft: string;
  /** Whether settings panel is open. */
  settingsOpen: boolean;
  /** Current footer hint text. */
  footerHint?: string;
}

/**
 * Per-frame context needed alongside canonical state for rendering and dispatch.
 */
export interface AskRuntime {
  questions: readonly PiAskFlowQuestion[];
  isMulti: boolean;
  currentOptions: readonly ExtendedOption[];
}

/**
 * An option as rendered in the list, possibly augmented with sentinel rows.
 */
export interface ExtendedOption {
  kind: "option" | "other" | "chat" | "next";
  option?: PiAskFlowOption;
  label: string;
  description?: string;
  preview?: string;
}

export function createInitialState(request: {
  questions: PiAskFlowQuestion[];
  priorAnswers?: Record<string, PiAskFlowAnswerEntry>;
}): AskState {
  const answers = new Map<string, PiAskFlowAnswerEntry>();
  if (request.priorAnswers) {
    for (const [id, entry] of Object.entries(request.priorAnswers)) {
      answers.set(id, entry);
    }
  }

  const notesByQuestion = new Map<string, string>();

  return {
    currentTab: 0,
    optionIndex: 0,
    inputMode: false,
    notesVisible: false,
    chatFocused: false,
    answers,
    multiSelectChecked: new Set(),
    notesByQuestion,
    focusedOptionHasPreview: false,
    submitChoiceIndex: 0,
    inputDraft: "",
    notesDraft: "",
    settingsOpen: false,
  };
}

export function buildExtendedOptions(
  question: PiAskFlowQuestion,
  _answers: ReadonlyMap<string, PiAskFlowAnswerEntry>,
): ExtendedOption[] {
  const opts: ExtendedOption[] = [];

  if (question.options) {
    for (const option of question.options) {
      opts.push({
        kind: "option",
        option,
        label: option.label,
        description: option.description,
        preview: option.preview,
      });
    }
  }

  // Always add "Type your own" sentinel
  opts.push({ kind: "other", label: "Type your own" });
  // Add chat sentinel
  opts.push({ kind: "chat", label: "Chat about this" });

  // For multi-select, add "Next" sentinel
  if (question.type === "multi") {
    opts.push({ kind: "next", label: "Confirm selection →" });
  }

  return opts;
}

export function getCurrentQuestion(
  state: AskState,
  questions: readonly PiAskFlowQuestion[],
): PiAskFlowQuestion | undefined {
  if (state.currentTab < 0 || state.currentTab >= questions.length) return undefined;
  return questions[state.currentTab];
}

export function isSubmitTab(state: AskState, questions: readonly PiAskFlowQuestion[]): boolean {
  return state.currentTab >= questions.length;
}

export function getFocusedOption(
  state: AskState,
  options: readonly ExtendedOption[],
): ExtendedOption | undefined {
  if (state.optionIndex < 0 || state.optionIndex >= options.length) return undefined;
  return options[state.optionIndex];
}
