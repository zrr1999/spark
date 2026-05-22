import {
  SENTINEL_LABELS,
  type PiAskFlowOption,
  type PiAskFlowQuestion,
  type PiAskFlowAnswerEntry,
} from "../schema.ts";

/**
 * Canonical UI state for the ask dialog. Single source of truth for the
 * controller and renderer.
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
  /** Current in-editor draft for the focused free-text row. */
  inputDraft: string;
  /** Preserved free-text drafts keyed by question id. */
  customDraftsByQuestion: ReadonlyMap<string, string>;
  /** Current draft in the notes editor. */
  notesDraft: string;
  /** Current footer hint text. */
  footerHint?: string;
}

/**
 * An option as rendered in the list, possibly augmented with sentinel rows.
 */
export interface ExtendedOption {
  kind: "option" | "other";
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
  const customDraftsByQuestion = new Map<string, string>();

  return {
    currentTab: 0,
    optionIndex: 0,
    inputMode: false,
    notesVisible: false,
    answers,
    multiSelectChecked: new Set(),
    notesByQuestion,
    focusedOptionHasPreview: false,
    submitChoiceIndex: 0,
    inputDraft: "",
    customDraftsByQuestion,
    notesDraft: "",
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

  opts.push({ kind: "other", label: SENTINEL_LABELS.other });

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
