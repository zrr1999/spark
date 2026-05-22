import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { AskState, ExtendedOption } from "../state/state.ts";
import { isSubmitTab } from "../state/state.ts";
import { SENTINEL_LABELS, type PiAskFlowQuestion, type PiAskFlowAnswerEntry } from "../schema.ts";

function enforceLineWidths(lines: string[], width: number): string[] {
  const maxWidth = Math.max(1, width);
  return lines.map((line) => truncateToWidth(line, maxWidth, "…"));
}

function appendWrappedText(
  lines: string[],
  text: string,
  width: number,
  firstPrefix = "",
  restPrefix = firstPrefix,
): void {
  lines.push(...wrapPrefixedText(text, width, firstPrefix, restPrefix));
}

function wrapPrefixedText(
  text: string,
  width: number,
  firstPrefix = "",
  restPrefix = firstPrefix,
): string[] {
  const wrapped: string[] = [];
  const contentWidth = Math.max(
    1,
    width - Math.max(visibleWidth(firstPrefix), visibleWidth(restPrefix)),
  );
  const paragraphs = text.split(/\r?\n/);
  for (const paragraph of paragraphs) {
    const paragraphLines = wrapTextWithAnsi(paragraph, contentWidth);
    const renderedLines = paragraphLines.length > 0 ? paragraphLines : [""];
    for (const line of renderedLines) {
      const prefix = wrapped.length === 0 ? firstPrefix : restPrefix;
      wrapped.push(`${prefix}${line}`);
    }
  }
  return wrapped.length > 0 ? wrapped : [firstPrefix];
}

// ---- Theme interface (matches pi-tui's Theme) ----

export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
  dim(text: string): string;
}

export interface PartialRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
  strikethrough?: (text: string) => string;
  dim?: (text: string) => string;
}

// ---- Status icons ----

const ICONS = {
  selected: "●",
  unselected: "○",
  checked: "☑",
  unchecked: "☐",
  submit: "→",
  elaborate: "✎",
  cancel: "✕",
  answered: "✓",
  unanswered: "?",
  note: "📝",
  preview: "▸",

  other: "○",
};

// ---- Labels (zh/en) ----

export type AskUILanguage = "zh" | "en";

const L: Record<
  AskUILanguage,
  {
    submit: string;
    elaborate: string;
    cancel: string;
    other: string;
    review: string;
    tab: string;
    question: string;
    notes: string;
    pressN: string;
    pressShiftN: string;
    typeAnswer: string;
    noAnswer: string;
    allAnswered: string;
    someUnanswered: string;
    footer: string;
  }
> = {
  zh: {
    submit: "提交",
    elaborate: "请先澄清",
    cancel: "取消",
    other: "输入自定义",
    review: "审核",
    tab: "Tab",
    question: "问题",
    notes: "备注",
    pressN: "n 添加备注",
    pressShiftN: "Shift+N 问题备注",

    typeAnswer: "输入你的回答…",
    noAnswer: "未回答",
    allAnswered: "全部已回答",
    someUnanswered: "个问题未回答",
    footer: "Enter 确认 · Esc 取消 · Tab 切换 · ↑↓ 导航",
  },
  en: {
    submit: "Submit",
    elaborate: "Elaborate first",
    cancel: "Cancel",
    other: SENTINEL_LABELS.other,
    review: "Review",
    tab: "Tab",
    question: "Question",
    notes: "Notes",
    pressN: "n to add note",
    pressShiftN: "Shift+N question note",

    typeAnswer: "Type your answer…",
    noAnswer: "unanswered",
    allAnswered: "All answered",
    someUnanswered: "unanswered",
    footer: "Enter confirm/next · Esc cancel · ←→ switch questions · ↑↓ navigate",
  },
};

// ---- Main render ----

export interface RenderInput {
  state: AskState;
  questions: readonly PiAskFlowQuestion[];
  optionsByTab: ReadonlyArray<readonly ExtendedOption[]>;
  theme: RenderTheme | PartialRenderTheme;
  width: number;
  language: AskUILanguage;
  title?: string;
  context?: string;
  editorDraft?: string;
  notesDraft?: string;
}

export function renderAskScreen(input: RenderInput): string[] {
  const {
    state,
    questions,
    optionsByTab,
    theme: rawTheme,
    width,
    language,
    title,
    context,
  } = input;
  const theme = normalizeRenderTheme(rawTheme);
  const labels = L[language];
  const lines: string[] = [];

  // --- Header ---
  if (title) {
    appendWrappedText(lines, theme.bold(title), width);
  }
  if (context) {
    appendWrappedText(lines, theme.dim(context), width);
  }
  if (title || context) {
    lines.push(theme.dim("─".repeat(Math.min(width, 60))));
  }

  // --- Tab bar ---
  const tabParts: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const isActive = i === state.currentTab;
    const label = q.header ?? `${labels.question} ${i + 1}`;
    const answered = state.answers.has(q.id);

    let tabText: string;
    if (isActive) {
      tabText = theme.fg("accent", `[${label}]`);
    } else if (answered) {
      tabText = theme.fg("success", `${label} ✓`);
    } else {
      tabText = theme.dim(label);
    }
    tabParts.push(tabText);
  }
  // Submit / Review tab
  const isSubmit = isSubmitTab(state, questions);
  const submitTabText = isSubmit
    ? theme.fg("accent", `[${labels.review}]`)
    : theme.dim(labels.review);
  tabParts.push(submitTabText);

  lines.push(tabParts.join("  "));
  lines.push(theme.dim("─".repeat(Math.min(width, 60))));
  lines.push("");

  // --- Content ---
  if (isSubmit) {
    renderSubmitTab(lines, state, questions, theme, width, labels);
  } else {
    const question = questions[state.currentTab];
    const options = optionsByTab[state.currentTab];
    if (question && options) {
      renderQuestionTab(lines, state, question, options, theme, width, labels);
    }
  }

  // --- Footer ---
  lines.push("");
  lines.push(theme.dim("─".repeat(Math.min(width, 60))));

  if (state.footerHint) {
    lines.push(theme.dim(state.footerHint));
  } else {
    lines.push(theme.dim(labels.footer));
  }

  return enforceLineWidths(lines, width);
}

// ---- Question tab rendering ----

function renderQuestionTab(
  lines: string[],
  state: AskState,
  question: PiAskFlowQuestion,
  options: readonly ExtendedOption[],
  theme: RenderTheme,
  width: number,
  labels: (typeof L)["en"],
): void {
  // Prompt
  appendWrappedText(lines, theme.bold(question.prompt), Math.max(1, width - 2), "  ");
  if (question.type === "multi") {
    lines.push(theme.dim("  (multi-select — Space to toggle, then Enter or → to confirm)"));
  }
  lines.push("");

  // Options list
  const isMulti = question.type === "multi";
  const answer = state.answers.get(question.id);
  const selectedValues = new Set(answer?.values ?? []);
  const focusedOption = options[state.optionIndex];
  const previewWidth =
    focusedOption?.preview && focusedOption.kind === "option" && width >= 84
      ? Math.min(44, Math.max(28, Math.floor(width * 0.34)))
      : 0;
  const preferredListWidth = Math.max(
    36,
    Math.min(width - previewWidth - 3, Math.floor(width * 0.48)),
  );
  const listWidth = previewWidth > 0 ? preferredListWidth : width;
  const optionLines: string[] = [];

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const isFocused = i === state.optionIndex;
    const isSelected = opt.kind === "option" && selectedValues.has(opt.option!.value);
    const isCustomSelected = opt.kind === "other" && answer?.kind === "custom";
    const isMultiChecked =
      isMulti && opt.kind === "option" && state.multiSelectChecked.has(opt.option!.value);

    let icon: string;
    let text: string;

    switch (opt.kind) {
      case "option": {
        if (isMulti) {
          icon = isMultiChecked ? ICONS.checked : ICONS.unchecked;
        } else {
          icon = isSelected ? ICONS.selected : ICONS.unselected;
        }
        text = opt.option!.label;
        break;
      }
      case "other": {
        icon = isCustomSelected ? ICONS.selected : ICONS.other;
        const draft = (state.inputDraft || answer?.customText || "").trim();
        text =
          state.inputMode || isFocused || draft ? `${labels.other}: ${draft || "_"}` : labels.other;
        break;
      }
    }

    const main = `${isFocused ? "▶" : icon} ${isFocused ? `${icon} ` : ""}${text}`;
    let styledMain: string;
    if (isFocused) {
      styledMain = theme.fg("accent", main);
    } else if ((isSelected && opt.kind === "option") || isCustomSelected) {
      styledMain = theme.fg("success", main);
    } else if (opt.kind === "other") {
      styledMain = theme.dim(main);
    } else {
      styledMain = main;
    }

    const description =
      opt.description && (isFocused || opt.kind === "option")
        ? theme.dim(`  — ${opt.description}`)
        : "";
    optionLines.push(
      ...wrapPrefixedText(
        `${styledMain}${description}`,
        listWidth,
        isFocused ? " " : "   ",
        "     ",
      ),
    );
  }

  if (previewWidth > 0 && focusedOption?.preview) {
    appendSideBySidePreview(
      lines,
      optionLines,
      focusedOption.preview,
      theme,
      listWidth,
      previewWidth,
    );
  } else {
    lines.push(...optionLines);
  }

  lines.push("");

  // Show current answer if any
  if (answer) {
    const answerText = formatAnswerBrief(answer, labels);
    appendWrappedText(lines, theme.fg("success", answerText), Math.max(1, width - 2), "  ");

    // Show notes indicator
    if (answer.notes) {
      appendWrappedText(
        lines,
        theme.dim(`${ICONS.note} ${answer.notes}`),
        Math.max(1, width - 2),
        "  ",
        "    ",
      );
    }
  }

  // Hints for available actions
  if (question.type === "multi") {
    lines.push(theme.dim(`  Space: toggle · Enter: next · ←→ switch questions · ${labels.pressN}`));
  } else if (focusedOption?.kind === "other") {
    lines.push(theme.dim("  Type directly · Enter: save/next · ←→ switch questions"));
  } else {
    lines.push(theme.dim(`  Enter: answer/next · ←→ switch questions · ${labels.pressN}`));
  }
}

// ---- Preview pane ----

function appendSideBySidePreview(
  lines: string[],
  optionLines: string[],
  preview: string,
  theme: RenderTheme,
  listWidth: number,
  previewWidth: number,
): void {
  const pane = renderPreviewPane(preview, theme, previewWidth);
  const rows = Math.max(optionLines.length, pane.length);
  for (let i = 0; i < rows; i++) {
    const left = padVisible(optionLines[i] ?? "", listWidth);
    const right = pane[i] ?? "";
    lines.push(`${left}  ${right}`.trimEnd());
  }
}

function renderPreviewPane(preview: string, theme: RenderTheme, width: number): string[] {
  const innerWidth = Math.max(12, width - 4);
  const previewLines = preview.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line, innerWidth));
  const maxPreviewLines = 10;
  const lines = [theme.dim(`┌─ Preview ${"─".repeat(Math.max(0, innerWidth - 10))}`)];
  for (let i = 0; i < Math.min(previewLines.length, maxPreviewLines); i++) {
    const line = previewLines[i] ?? "";
    const truncated = truncateToWidth(line, innerWidth);
    lines.push(theme.dim(`│ ${truncated}`));
  }
  if (previewLines.length > maxPreviewLines) {
    lines.push(theme.dim(`│ … ${previewLines.length - maxPreviewLines} more lines`));
  }
  lines.push(theme.dim(`└${"─".repeat(Math.max(0, innerWidth + 2))}`));
  return lines;
}

function padVisible(text: string, width: number): string {
  const visibleLength = visibleWidth(text);
  return `${text}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

// ---- Submit / Review tab ----

function renderSubmitTab(
  lines: string[],
  state: AskState,
  questions: readonly PiAskFlowQuestion[],
  theme: RenderTheme,
  width: number,
  labels: (typeof L)["en"],
): void {
  lines.push(truncateToWidth(`  ${theme.bold("Review your answers")}`, width));
  lines.push("");

  let allAnswered = true;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = state.answers.get(q.id);
    const answerText = answer ? formatAnswerBrief(answer, labels) : labels.noAnswer;

    const header = q.header ?? `Q${i + 1}`;
    if (answer) {
      appendWrappedText(
        lines,
        `${theme.fg("success", "✓")} ${theme.bold(header)}: ${answerText}`,
        Math.max(1, width - 2),
        "  ",
        "    ",
      );
    } else {
      allAnswered = false;
      appendWrappedText(
        lines,
        `${theme.fg("warning", "?")} ${theme.bold(header)}: ${theme.fg("warning", labels.noAnswer)}`,
        Math.max(1, width - 2),
        "  ",
        "    ",
      );
    }
    // Show notes if present
    const note = state.notesByQuestion.get(q.id);
    if (note) {
      appendWrappedText(
        lines,
        theme.dim(`${ICONS.note} ${note}`),
        Math.max(1, width - 4),
        "    ",
        "      ",
      );
    }
  }

  lines.push("");

  if (!allAnswered) {
    lines.push(
      theme.fg(
        "warning",
        `  ⚠ ${questions.length - countAnswered(state, questions)} ${labels.someUnanswered}`,
      ),
    );
    lines.push("");
  }

  // Submit / Elaborate / Cancel picker
  const actions = [
    {
      icon: ICONS.submit,
      label: labels.submit,
      desc: allAnswered ? labels.allAnswered : labels.someUnanswered,
    },
    { icon: ICONS.elaborate, label: labels.elaborate, desc: "Add notes and re-ask" },
    { icon: ICONS.cancel, label: labels.cancel, desc: "Cancel and return to agent" },
  ];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const isFocused = i === state.submitChoiceIndex;
    if (isFocused) {
      appendWrappedText(
        lines,
        `${theme.fg("accent", `▶ ${action.icon} ${action.label}`)}  ${theme.dim(action.desc)}`,
        Math.max(1, width - 2),
        "  ",
        "    ",
      );
    } else {
      appendWrappedText(
        lines,
        `${action.icon} ${theme.dim(action.label)}  ${theme.dim(action.desc)}`,
        Math.max(1, width - 3),
        "   ",
        "     ",
      );
    }
  }

  lines.push("");
  lines.push(theme.dim("  1=Submit · 2=Elaborate · 3=Cancel · ↑↓ navigate"));
}

// ---- Helpers ----

function formatAnswerBrief(answer: PiAskFlowAnswerEntry, labels: (typeof L)["en"]): string {
  switch (answer.kind) {
    case "option":
      return answer.labels?.[0] ?? answer.values[0] ?? "?";
    case "multi":
      return answer.labels?.length ? answer.labels.join(", ") : answer.values.join(", ");
    case "custom":
      return `"${answer.customText?.slice(0, 40) ?? ""}"`;
    case "skipped":
      return labels.noAnswer;
  }
}

export function normalizeRenderTheme(theme: PartialRenderTheme | undefined): RenderTheme {
  return {
    fg: typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_color, text) => text,
    bold: typeof theme?.bold === "function" ? theme.bold.bind(theme) : (text) => text,
    strikethrough:
      typeof theme?.strikethrough === "function" ? theme.strikethrough.bind(theme) : (text) => text,
    dim: typeof theme?.dim === "function" ? theme.dim.bind(theme) : (text) => text,
  };
}

function countAnswered(state: AskState, questions: readonly PiAskFlowQuestion[]): number {
  let count = 0;
  for (const q of questions) {
    if (state.answers.has(q.id)) count++;
  }
  return count;
}
