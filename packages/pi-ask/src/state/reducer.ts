import type { PiAskFlowQuestion, PiAskFlowResult, PiAskFlowAnswerEntry } from "../schema.ts";
import type { AskState, ExtendedOption } from "./state.ts";
import { isSubmitTab } from "./state.ts";

// ---- Actions ----

export type AskAction =
  | { kind: "move_option"; direction: -1 | 1 }
  | { kind: "move_tab"; direction: -1 | 1 | "submit" }
  | { kind: "jump_tab"; index: number }
  | { kind: "select_option" }
  | { kind: "toggle_multi_option" }
  | { kind: "commit_multi" }
  | { kind: "enter_input" }
  | { kind: "update_input_draft"; text: string }
  | { kind: "commit_input" }
  | { kind: "enter_notes"; questionId: string }
  | { kind: "update_notes_draft"; text: string }
  | { kind: "commit_notes"; questionId: string }
  | { kind: "close_notes" }
  | { kind: "enter_chat" }
  | { kind: "submit" }
  | { kind: "elaborate" }
  | { kind: "cancel" }
  | { kind: "move_submit_choice"; direction: -1 | 1 }
  | { kind: "open_settings" }
  | { kind: "close_settings" }
  | { kind: "apply_number_shortcut"; index: number }
  | { kind: "toggle_question_type" };

// ---- Effects ----

export type Effect =
  | { kind: "done"; result: PiAskFlowResult }
  | { kind: "notify"; message: string; level?: "info" | "warning" }
  | { kind: "enter_input_mode" }
  | { kind: "enter_notes_mode" }
  | { kind: "request_rerender" };

export interface ApplyResult {
  state: AskState;
  effects: readonly Effect[];
}

// ---- Context ----

export interface ApplyContext {
  questions: readonly PiAskFlowQuestion[];
  optionsByTab: ReadonlyArray<readonly ExtendedOption[]>;
}

// ---- Reducer ----

export function reduce(state: AskState, action: AskAction, ctx: ApplyContext): ApplyResult {
  switch (action.kind) {
    case "move_option":
      return moveOption(state, action.direction, ctx);
    case "move_tab":
      return moveTab(state, action.direction, ctx);
    case "jump_tab":
      return jumpTab(state, action.index, ctx);
    case "select_option":
      return selectOption(state, ctx);
    case "toggle_multi_option":
      return toggleMultiOption(state, ctx);
    case "commit_multi":
      return commitMulti(state, ctx);
    case "enter_input":
      return enterInput(state);
    case "update_input_draft":
      return updateInputDraft(state, action.text);
    case "commit_input":
      return commitInput(state, ctx);
    case "enter_notes":
      return enterNotes(state, action.questionId);
    case "update_notes_draft":
      return updateNotesDraft(state, action.text);
    case "commit_notes":
      return commitNotes(state, action.questionId);
    case "close_notes":
      return closeNotes(state);
    case "enter_chat":
      return enterChat(state, ctx);
    case "submit":
      return submit(state, ctx);
    case "elaborate":
      return elaborate(state, ctx);
    case "cancel":
      return cancel(state, ctx);
    case "move_submit_choice":
      return moveSubmitChoice(state, action.direction, ctx);
    case "open_settings":
      return { state: { ...state, settingsOpen: true }, effects: [] };
    case "close_settings":
      return { state: { ...state, settingsOpen: false }, effects: [] };
    case "apply_number_shortcut":
      return applyNumberShortcut(state, action.index, ctx);
    case "toggle_question_type":
      return toggleQuestionType(state, ctx);
  }
}

// ---- Implementations ----

function moveOption(state: AskState, direction: -1 | 1, ctx: ApplyContext): ApplyResult {
  if (isSubmitTab(state, ctx.questions) || state.inputMode || state.notesVisible)
    return { state, effects: [] };
  const options = ctx.optionsByTab[state.currentTab];
  if (!options || options.length === 0) return { state, effects: [] };
  const max = options.length - 1;
  const next = Math.max(0, Math.min(max, state.optionIndex + direction));
  const focusedOptionHasPreview = computeHasPreview(options[next]);
  return { state: { ...state, optionIndex: next, focusedOptionHasPreview }, effects: [] };
}

function moveTab(state: AskState, direction: -1 | 1 | "submit", ctx: ApplyContext): ApplyResult {
  const maxTab = ctx.questions.length; // includes submit tab
  let next: number;
  if (direction === "submit") {
    next = maxTab;
  } else {
    next = Math.max(0, Math.min(maxTab, state.currentTab + direction));
  }
  return jumpTab(state, next, ctx);
}

function jumpTab(state: AskState, index: number, ctx: ApplyContext): ApplyResult {
  const clamped = Math.max(0, Math.min(ctx.questions.length, index));
  const newOptions = clamped < ctx.questions.length ? ctx.optionsByTab[clamped] : undefined;
  return {
    state: {
      ...state,
      currentTab: clamped,
      optionIndex: 0,
      inputMode: false,
      notesVisible: false,
      multiSelectChecked: new Set(),
      inputDraft: "",
      notesDraft: "",
      submitChoiceIndex: 0,
      chatFocused: false,
      focusedOptionHasPreview: newOptions ? computeHasPreview(newOptions[0]) : false,
    },
    effects: [{ kind: "request_rerender" }],
  };
}

function selectOption(state: AskState, ctx: ApplyContext): ApplyResult {
  if (isSubmitTab(state, ctx.questions)) return { state, effects: [] };
  const options = ctx.optionsByTab[state.currentTab];
  if (!options) return { state, effects: [] };
  const focused = options[state.optionIndex];
  if (!focused) return { state, effects: [] };

  switch (focused.kind) {
    case "option":
      return commitOptionAnswer(state, ctx, focused);
    case "other":
      return enterInput(state);
    case "chat":
      return enterChat(state, ctx);
    case "next":
      return commitMulti(state, ctx);
  }
}

function commitOptionAnswer(
  state: AskState,
  ctx: ApplyContext,
  focused: ExtendedOption,
): ApplyResult {
  const question = ctx.questions[state.currentTab];
  const answer: PiAskFlowAnswerEntry = {
    questionId: question.id,
    kind: "option",
    values: [focused.option!.value],
    preview: focused.preview,
  };

  // Attach any pending notes
  const pendingNote = state.notesByQuestion.get(question.id);
  if (pendingNote) answer.notes = pendingNote;

  const answers = new Map(state.answers);
  answers.set(question.id, answer);

  return {
    state: { ...state, answers, inputMode: false, inputDraft: "" },
    effects: [{ kind: "request_rerender" }],
  };
}

function toggleMultiOption(state: AskState, ctx: ApplyContext): ApplyResult {
  const options = ctx.optionsByTab[state.currentTab];
  if (!options) return { state, effects: [] };
  const focused = options[state.optionIndex];
  if (!focused || focused.kind !== "option") return { state, effects: [] };

  const checked = new Set(state.multiSelectChecked);
  if (checked.has(focused.option!.value)) {
    checked.delete(focused.option!.value);
  } else {
    checked.add(focused.option!.value);
  }

  return {
    state: { ...state, multiSelectChecked: checked },
    effects: [{ kind: "request_rerender" }],
  };
}

function commitMulti(state: AskState, ctx: ApplyContext): ApplyResult {
  const question = ctx.questions[state.currentTab];
  if (state.multiSelectChecked.size === 0) return { state, effects: [] };

  const answer: PiAskFlowAnswerEntry = {
    questionId: question.id,
    kind: "multi",
    values: [...state.multiSelectChecked],
  };

  const pendingNote = state.notesByQuestion.get(question.id);
  if (pendingNote) answer.notes = pendingNote;

  const answers = new Map(state.answers);
  answers.set(question.id, answer);

  return {
    state: { ...state, answers, multiSelectChecked: new Set() },
    effects: [{ kind: "request_rerender" }],
  };
}

function enterInput(state: AskState): ApplyResult {
  return {
    state: { ...state, inputMode: true, inputDraft: "" },
    effects: [{ kind: "enter_input_mode" }],
  };
}

function updateInputDraft(state: AskState, text: string): ApplyResult {
  return { state: { ...state, inputDraft: text }, effects: [] };
}

function commitInput(state: AskState, ctx: ApplyContext): ApplyResult {
  const question = ctx.questions[state.currentTab];
  const text = state.inputDraft.trim();
  if (!text) return { state: { ...state, inputMode: false, inputDraft: "" }, effects: [] };

  const answer: PiAskFlowAnswerEntry = {
    questionId: question.id,
    kind: "custom",
    values: [],
    customText: text,
  };

  const answers = new Map(state.answers);
  answers.set(question.id, answer);

  return {
    state: { ...state, answers, inputMode: false, inputDraft: "" },
    effects: [{ kind: "request_rerender" }],
  };
}

function enterNotes(state: AskState, questionId: string): ApplyResult {
  return {
    state: {
      ...state,
      notesVisible: true,
      notesDraft: state.notesByQuestion.get(questionId) ?? "",
    },
    effects: [{ kind: "enter_notes_mode" }],
  };
}

function updateNotesDraft(state: AskState, text: string): ApplyResult {
  return { state: { ...state, notesDraft: text }, effects: [] };
}

function commitNotes(state: AskState, questionId: string): ApplyResult {
  const notesByQuestion = new Map(state.notesByQuestion);
  if (state.notesDraft.trim()) {
    notesByQuestion.set(questionId, state.notesDraft.trim());
  } else {
    notesByQuestion.delete(questionId);
  }
  return {
    state: { ...state, notesVisible: false, notesByQuestion, notesDraft: "" },
    effects: [{ kind: "request_rerender" }],
  };
}

function closeNotes(state: AskState): ApplyResult {
  return {
    state: { ...state, notesVisible: false, notesDraft: "" },
    effects: [{ kind: "request_rerender" }],
  };
}

function enterChat(state: AskState, _ctx: ApplyContext): ApplyResult {
  // Chat: collect partial answers and return them with mode=chat
  const answers = toAnswerRecord(state.answers);
  const result: PiAskFlowResult = {
    answers,
    mode: "chat",
    cancelled: false,
    nextAction: "resume",
  };
  return { state, effects: [{ kind: "done", result }] };
}

function submit(state: AskState, _ctx: ApplyContext): ApplyResult {
  const answers = toAnswerRecord(state.answers);
  const result: PiAskFlowResult = {
    answers,
    mode: "submit",
    cancelled: false,
    nextAction: "resume",
  };
  return { state, effects: [{ kind: "done", result }] };
}

function elaborate(state: AskState, _ctx: ApplyContext): ApplyResult {
  const answers = toAnswerRecord(state.answers);
  const notes: Array<{ questionId: string; note: string }> = [];
  for (const [qId, note] of state.notesByQuestion) {
    if (note.trim()) notes.push({ questionId: qId, note: note.trim() });
  }
  const affectedQuestionIds = notes.map((n) => n.questionId);

  const result: PiAskFlowResult = {
    answers,
    mode: "elaborate",
    cancelled: false,
    elaboration: {
      affectedQuestionIds,
      preservedAnswers: answers,
      notes,
    },
    nextAction: "clarify_then_reask",
  };
  return { state, effects: [{ kind: "done", result }] };
}

function cancel(state: AskState, _ctx: ApplyContext): ApplyResult {
  const result: PiAskFlowResult = {
    answers: toAnswerRecord(state.answers),
    mode: "cancel",
    cancelled: true,
    nextAction: "block",
  };
  return { state, effects: [{ kind: "done", result }] };
}

function moveSubmitChoice(state: AskState, direction: -1 | 1, ctx: ApplyContext): ApplyResult {
  if (!isSubmitTab(state, ctx.questions)) return { state, effects: [] };
  const max = 2; // Submit(0), Elaborate(1), Cancel(2)
  const next = Math.max(0, Math.min(max, state.submitChoiceIndex + direction));
  return { state: { ...state, submitChoiceIndex: next }, effects: [{ kind: "request_rerender" }] };
}

function applyNumberShortcut(state: AskState, index: number, ctx: ApplyContext): ApplyResult {
  if (isSubmitTab(state, ctx.questions)) {
    // Submit tab: 1=Submit, 2=Elaborate, 3=Cancel
    if (index === 0) return submit(state, ctx);
    if (index === 1) return elaborate(state, ctx);
    if (index === 2) return cancel(state, ctx);
    return { state, effects: [] };
  }

  // Question tab: select option by number
  const options = ctx.optionsByTab[state.currentTab];
  if (!options || index >= options.length) return { state, effects: [] };
  const focused = options[index];
  if (!focused) return { state, effects: [] };

  const question = ctx.questions[state.currentTab];
  if (question.type === "multi" && focused.kind === "option") {
    const checked = new Set(state.multiSelectChecked);
    if (checked.has(focused.option!.value)) {
      checked.delete(focused.option!.value);
    } else {
      checked.add(focused.option!.value);
    }
    return {
      state: {
        ...state,
        multiSelectChecked: checked,
        optionIndex: index,
        focusedOptionHasPreview: computeHasPreview(focused),
      },
      effects: [{ kind: "request_rerender" }],
    };
  }

  // Update optionIndex then select
  return selectOption(
    { ...state, optionIndex: index, focusedOptionHasPreview: computeHasPreview(focused) },
    ctx,
  );
}

function toggleQuestionType(state: AskState, _ctx: ApplyContext): ApplyResult {
  // Toggle between single and multi for current question
  // This is a view-level concern - the question type doesn't change in schema
  // But we can track it as a runtime override
  return { state, effects: [] };
}

// ---- Helpers ----

function computeHasPreview(option?: ExtendedOption): boolean {
  return !!(option?.preview && option.preview.trim().length > 0);
}

function toAnswerRecord(
  answers: ReadonlyMap<string, PiAskFlowAnswerEntry>,
): Record<string, PiAskFlowAnswerEntry> {
  const record: Record<string, PiAskFlowAnswerEntry> = {};
  for (const [id, entry] of answers) {
    record[id] = entry;
  }
  return record;
}
