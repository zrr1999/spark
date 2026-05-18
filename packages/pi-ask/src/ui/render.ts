import type { AskState, ExtendedOption } from "../state/state.ts";
import { isSubmitTab } from "../state/state.ts";
import type { PiAskFlowQuestion, PiAskFlowAnswerEntry } from "../schema.ts";

function truncateToWidth(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, maxWidth - 1) + "…";
}

// ---- Theme interface (matches pi-tui's Theme) ----

export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
  dim(text: string): string;
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
  chat: "💬",
  other: "…",
  settings: "⚙",
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
    chat: string;
    next: string;
    settings: string;
    review: string;
    tab: string;
    question: string;
    notes: string;
    pressN: string;
    pressShiftN: string;
    pressQ: string;
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
    chat: "聊聊这个",
    next: "确认选择 →",
    settings: "设置",
    review: "审核",
    tab: "Tab",
    question: "问题",
    notes: "备注",
    pressN: "n 添加备注",
    pressShiftN: "Shift+N 问题备注",
    pressQ: "? 设置",
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
    other: "Type your own",
    chat: "Chat about this",
    next: "Confirm selection →",
    settings: "Settings",
    review: "Review",
    tab: "Tab",
    question: "Question",
    notes: "Notes",
    pressN: "n to add note",
    pressShiftN: "Shift+N question note",
    pressQ: "? settings",
    typeAnswer: "Type your answer…",
    noAnswer: "unanswered",
    allAnswered: "All answered",
    someUnanswered: "unanswered",
    footer: "Enter confirm · Esc cancel · Tab switch · ↑↓ navigate",
  },
};

// ---- Main render ----

export interface RenderInput {
  state: AskState;
  questions: readonly PiAskFlowQuestion[];
  optionsByTab: ReadonlyArray<readonly ExtendedOption[]>;
  theme: RenderTheme;
  width: number;
  language: AskUILanguage;
  title?: string;
  context?: string;
  editorDraft?: string;
  notesDraft?: string;
}

export function renderAskScreen(input: RenderInput): string[] {
  const { state, questions, optionsByTab, theme, width, language, title } = input;
  const labels = L[language];
  const lines: string[] = [];
  const truncate = (text: string, max?: number) => truncateToWidth(text, max ?? width);

  // --- Header ---
  if (title) {
    lines.push(truncate(`${theme.bold(title)}`));
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
  if (state.settingsOpen) {
    renderSettingsPanel(lines, theme, width, labels);
  } else if (isSubmit) {
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
  } else if (state.settingsOpen) {
    lines.push(theme.dim("Esc close · ↑↓ navigate · Enter toggle"));
  } else {
    lines.push(theme.dim(labels.footer));
  }

  return lines;
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
  const truncate = (text: string, max?: number) => truncateToWidth(text, max ?? width);

  // Prompt
  lines.push(truncate(`  ${theme.bold(question.prompt)}`));
  if (question.type === "multi") {
    lines.push(theme.dim("  (multi-select — Space to toggle, then Enter or → to confirm)"));
  }
  lines.push("");

  // Options list
  const isMulti = question.type === "multi";
  const answer = state.answers.get(question.id);
  const selectedValues = new Set(answer?.values ?? []);

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const isFocused = i === state.optionIndex;
    const isSelected = opt.kind === "option" && selectedValues.has(opt.option!.value);
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
      case "other":
        icon = ICONS.other;
        text = labels.other;
        break;
      case "chat":
        icon = ICONS.chat;
        text = labels.chat;
        break;
      case "next":
        icon = "→";
        text = labels.next;
        break;
    }

    let line: string;
    if (isFocused) {
      line = ` ${theme.fg("accent", `▶ ${icon} ${text}`)}`;
    } else if (isSelected && opt.kind === "option") {
      line = `   ${theme.fg("success", `${icon} ${text}`)}`;
    } else if (opt.kind === "other" || opt.kind === "chat" || opt.kind === "next") {
      line = `   ${theme.dim(`${icon} ${text}`)}`;
    } else {
      line = `   ${icon} ${text}`;
    }

    // Description for focused or non-sentinel options
    if (opt.description && (isFocused || opt.kind === "option")) {
      line += theme.dim(`  — ${opt.description}`);
    }

    lines.push(truncate(line));

    // Preview for focused preview-enabled option
    if (isFocused && opt.preview && opt.kind === "option") {
      renderPreviewPane(lines, opt.preview, theme, width);
    }
  }

  lines.push("");

  // Show current answer if any
  if (answer) {
    const answerText = formatAnswerBrief(answer, labels);
    lines.push(theme.fg("success", `  ${answerText}`));

    // Show notes indicator
    if (answer.notes) {
      lines.push(theme.dim(`  ${ICONS.note} ${truncate(answer.notes, width - 4)}`));
    }
  }

  // Hints for available actions
  if (question.type === "multi") {
    lines.push(theme.dim(`  Space: toggle · Enter: confirm multi · ${labels.pressN}`));
  } else {
    lines.push(theme.dim(`  ${labels.pressN} · ${labels.pressShiftN} · ${labels.pressQ}`));
  }
}

// ---- Preview pane ----

function renderPreviewPane(
  lines: string[],
  preview: string,
  theme: RenderTheme,
  width: number,
): void {
  const previewLines = preview.split("\n");
  const maxPreviewLines = 10;
  const indent = "    ";

  lines.push(theme.dim(`${indent}┌─ preview ─`));
  for (let i = 0; i < Math.min(previewLines.length, maxPreviewLines); i++) {
    const line = previewLines[i];
    const truncated = truncateToWidth(line, width - 8);
    lines.push(theme.dim(`${indent}│ ${truncated}`));
  }
  if (previewLines.length > maxPreviewLines) {
    lines.push(theme.dim(`${indent}│ … ${previewLines.length - maxPreviewLines} more lines`));
  }
  lines.push(theme.dim(`${indent}└${"─".repeat(Math.min(width - 6, 12))}`));
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
  const truncate = (text: string, max?: number) => truncateToWidth(text, max ?? width);

  lines.push(truncate(`  ${theme.bold("Review your answers")}`));
  lines.push("");

  let allAnswered = true;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = state.answers.get(q.id);
    const answerText = answer ? formatAnswerBrief(answer, labels) : labels.noAnswer;

    const header = q.header ?? `Q${i + 1}`;
    if (answer) {
      lines.push(`  ${theme.fg("success", "✓")} ${theme.bold(header)}: ${answerText}`);
    } else {
      allAnswered = false;
      lines.push(
        `  ${theme.fg("warning", "?")} ${theme.bold(header)}: ${theme.fg("warning", labels.noAnswer)}`,
      );
    }
    // Show notes if present
    const note = state.notesByQuestion.get(q.id);
    if (note) {
      lines.push(`    ${theme.dim(`${ICONS.note} ${truncate(note, width - 6)}`)}`);
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
      lines.push(
        truncate(
          `  ${theme.fg("accent", `▶ ${action.icon} ${action.label}`)}  ${theme.dim(action.desc)}`,
        ),
      );
    } else {
      lines.push(`   ${action.icon} ${theme.dim(action.label)}  ${theme.dim(action.desc)}`);
    }
  }

  lines.push("");
  lines.push(theme.dim("  1=Submit · 2=Elaborate · 3=Cancel · ↑↓ navigate"));
}

// ---- Settings panel ----

function renderSettingsPanel(
  lines: string[],
  theme: RenderTheme,
  width: number,
  labels: (typeof L)["en"],
): void {
  const truncate = (text: string) => truncateToWidth(text, width);
  lines.push(truncate(`  ${theme.bold(labels.settings)}`));
  lines.push("");
  lines.push(theme.dim("  Settings panel — configure keymaps and behaviour"));
  lines.push(theme.dim("  Edit ~/.pi/agent/extensions/pi-ask.json directly"));
  lines.push(theme.dim("  or use /ask-settings command."));
}

// ---- Helpers ----

function formatAnswerBrief(answer: PiAskFlowAnswerEntry, labels: (typeof L)["en"]): string {
  switch (answer.kind) {
    case "option":
      return answer.values[0] ?? "?";
    case "multi":
      return answer.values.join(", ");
    case "custom":
      return `"${answer.customText?.slice(0, 40) ?? ""}"`;
    case "freeform":
      return answer.customText?.slice(0, 40) ?? "";
    case "skipped":
      return labels.noAnswer;
  }
}

function countAnswered(state: AskState, questions: readonly PiAskFlowQuestion[]): number {
  let count = 0;
  for (const q of questions) {
    if (state.answers.has(q.id)) count++;
  }
  return count;
}
