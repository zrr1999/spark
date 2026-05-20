import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { SENTINEL_LABELS } from "./schema.ts";

export type PiAskMode = "clarification" | "decision" | "approval" | "unblock";
export type PiAskQuestionType = "single" | "multi" | "freeform";

export interface PiAskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface PiAskQuestion {
  id: string;
  prompt: string;
  header?: string;
  type?: PiAskQuestionType | "preview";
  options?: PiAskOption[];
  required?: boolean;
}

export interface PiAskRequest {
  title?: string;
  mode?: PiAskMode;
  context?: string;
  questions: PiAskQuestion[];
}

export interface PiAskAnswerEntry {
  values: string[];
  labels: string[];
  customText?: string;
  comment?: string;
  notes?: string;
  preview?: string;
}

export type PiAskResultStatus = "answered" | "cancelled" | "no_selection";

export interface PiAskResult {
  status: PiAskResultStatus;
  cancelled: boolean;
  answers: Record<string, PiAskAnswerEntry>;
  nextAction: "resume" | "block";
}

export interface PiAskUi {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  selectWithCustom?: (
    title: string,
    input: { options: string[]; customLabel: string },
  ) => Promise<{ value?: string; customText?: string } | string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
  notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
}

export interface PiAskExtensionApi {
  registerTool(config: PiAskToolConfig): void;
}

interface PiAskToolConfig {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: unknown,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolCallComponent {
  render(width: number): string[];
}

class ToolCallText implements ToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

export function createAskUserRequest(input: PiAskRequest): PiAskRequest {
  if (input.questions.length === 0) throw new Error("ask_user needs at least one question");
  const seen = new Set<string>();
  for (const question of input.questions) {
    if (!question.id.trim()) throw new Error("question id is required");
    if (seen.has(question.id)) throw new Error(`duplicate question id: ${question.id}`);
    seen.add(question.id);
    if (!question.prompt.trim()) throw new Error(`question prompt is required: ${question.id}`);
    if (
      (question.type ?? "single") !== "freeform" &&
      (!question.options || question.options.length === 0)
    ) {
      throw new Error(`question options are required: ${question.id}`);
    }
  }
  return input;
}

export async function askUser(request: PiAskRequest, ui?: PiAskUi): Promise<PiAskResult> {
  const normalized = createAskUserRequest(request);
  if (!ui) return defaultAskUserResult(normalized);

  const answers: Record<string, PiAskAnswerEntry> = {};
  for (const question of normalized.questions) {
    const resolved = await resolveQuestion(question, normalized, ui);
    if (!resolved.answer) {
      if (requiresExplicitAskUserSelection(normalized, question))
        return createAskUserResult({ cancelled: false, answers, status: "no_selection" });
      continue;
    }
    answers[question.id] = resolved.answer;
    if (
      requiresExplicitAskUserSelection(normalized, question) &&
      resolved.answer.values.length === 0
    ) {
      return createAskUserResult({
        cancelled: false,
        answers,
        status: "answered",
        nextAction: "block",
      });
    }
  }
  return createAskUserResult({ cancelled: false, answers });
}

export function defaultAskUserResult(request: PiAskRequest): PiAskResult {
  if (requestRequiresExplicitAskUserSelection(request)) {
    return createAskUserResult({ cancelled: false, answers: {}, status: "no_selection" });
  }

  const answers: Record<string, PiAskAnswerEntry> = {};
  for (const question of request.questions) {
    const first = question.options?.[0];
    answers[question.id] = {
      values: first ? [first.value] : [],
      labels: first ? [first.label] : [],
      customText: first ? undefined : "",
    };
  }
  return createAskUserResult({ cancelled: false, answers });
}

export function createAskUserResult(
  input: Omit<PiAskResult, "status" | "nextAction"> &
    Partial<Pick<PiAskResult, "status" | "nextAction">>,
): PiAskResult {
  const status = input.status ?? inferAskUserResultStatus(input);
  return {
    ...input,
    status,
    nextAction: input.nextAction ?? (status === "answered" ? "resume" : "block"),
  };
}

export function registerPiAskTools(pi: PiAskExtensionApi): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a structured clarification, decision, approval, or unblock question and return stable structured answers.",
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({
          description: "clarification | decision | approval | unblock",
        }),
      ),
      context: Type.Optional(Type.String()),
      questions: Type.Array(
        Type.Object({
          id: Type.String(),
          prompt: Type.String(),
          type: Type.Optional(Type.String({ description: "single | multi | freeform" })),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                value: Type.String(),
                label: Type.String(),
                description: Type.Optional(Type.String()),
              }),
            ),
          ),
          required: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
    renderCall(args, theme) {
      const questionCount = Array.isArray(args.questions) ? args.questions.length : undefined;
      return renderToolCall(
        "ask_user",
        [
          formatStringArg(args.title, { prefix: "title=" }),
          formatStringArg(args.mode, { fallback: "clarification" }),
          questionCount === undefined ? undefined : `${questionCount}q`,
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = decodeAskRequest(params);
      const result = await askUser(request, ctxUi(ctx));
      return {
        content: [{ type: "text", text: summarizeResult(request, result) }],
        details: {
          request: request as unknown as Record<string, unknown>,
          result: result as unknown as Record<string, unknown>,
        },
      };
    },
  });
}

function decodeAskRequest(params: Record<string, unknown>): PiAskRequest {
  const questions = Array.isArray(params.questions)
    ? (params.questions as Array<Record<string, unknown>>).map(
        (raw) =>
          ({
            id: typeof raw.id === "string" ? raw.id : "",
            prompt: typeof raw.prompt === "string" ? raw.prompt : "",
            type: raw.type as PiAskQuestionType | undefined,
            options: Array.isArray(raw.options)
              ? (raw.options as Array<Record<string, unknown>>).map(
                  (entry) =>
                    ({
                      value: typeof entry.value === "string" ? entry.value : "",
                      label: typeof entry.label === "string" ? entry.label : "",
                      description: entry.description as string | undefined,
                    }) satisfies PiAskOption,
                )
              : undefined,
            required: raw.required === true,
          }) satisfies PiAskQuestion,
      )
    : [];

  return createAskUserRequest({
    title: params.title as string | undefined,
    mode: params.mode as PiAskMode | undefined,
    context: params.context as string | undefined,
    questions,
  });
}

function ctxUi(ctx: unknown): PiAskUi | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const ui = (ctx as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") return undefined;
  return {
    select:
      typeof (ui as { select?: unknown }).select === "function"
        ? (ui as { select: PiAskUi["select"] }).select
        : undefined,
    selectWithCustom:
      typeof (ui as { selectWithCustom?: unknown }).selectWithCustom === "function"
        ? (ui as { selectWithCustom: PiAskUi["selectWithCustom"] }).selectWithCustom
        : undefined,
    confirm:
      typeof (ui as { confirm?: unknown }).confirm === "function"
        ? (ui as { confirm: PiAskUi["confirm"] }).confirm
        : undefined,
    input:
      typeof (ui as { input?: unknown }).input === "function"
        ? (ui as { input: PiAskUi["input"] }).input
        : undefined,
    notify:
      typeof (ui as { notify?: unknown }).notify === "function"
        ? (ui as { notify: PiAskUi["notify"] }).notify
        : undefined,
  };
}

interface ResolvedQuestion {
  answer?: PiAskAnswerEntry;
}

async function resolveQuestion(
  question: PiAskQuestion,
  request: PiAskRequest,
  ui: PiAskUi,
): Promise<ResolvedQuestion> {
  const title = request.title ? `${request.title} — ${question.prompt}` : question.prompt;
  if ((question.type ?? "single") === "freeform") {
    const text = await ui.input?.(title, "");
    if (text === undefined) return {};
    return { answer: { values: [], labels: [], customText: text } };
  }

  const questionType = (question.type ?? "single") as Exclude<PiAskQuestionType, "freeform">;

  if (question.options && (ui.selectWithCustom || ui.select)) {
    const selected = await selectQuestionOptionWithCustom(ui, title, question.options);
    if (!selected) return {};
    if (selected.customText !== undefined) {
      return {
        answer: parseOptionText(question.options, selected.customText, questionType),
      };
    }
    return {
      answer: parseOptionText(question.options, selected.value ?? "", questionType),
    };
  }

  if (
    request.mode === "approval" &&
    (question.type ?? "single") === "single" &&
    question.options &&
    question.options.length >= 2 &&
    ui.confirm
  ) {
    const ok = await ui.confirm(title, request.context ?? "");
    if (ok === undefined) return {};
    const chosen = ok ? question.options[0] : question.options[1];
    return { answer: { values: [chosen.value], labels: [chosen.label] } };
  }

  if (ui.input) {
    const prompt = question.options
      ? `${title} — choose one of [${question.options.map((option) => option.label).join(", ")}] or enter custom text`
      : title;
    const text = await ui.input(prompt, question.options?.[0]?.label ?? "");
    if (!text) return {};
    return {
      answer: parseOptionText(question.options ?? [], text, questionType),
    };
  }

  return {};
}

interface SelectWithCustomResult {
  value?: string;
  customText?: string;
}

async function selectQuestionOptionWithCustom(
  ui: PiAskUi,
  title: string,
  options: PiAskOption[],
): Promise<SelectWithCustomResult | undefined> {
  const labels = options.map((option) => option.label);
  if (ui.selectWithCustom) {
    const selected = await ui.selectWithCustom(title, {
      options: labels,
      customLabel: SENTINEL_LABELS.other,
    });
    if (!selected) return undefined;
    if (typeof selected === "string") return { value: selected };
    return selected;
  }

  const selected = await ui.select?.(title, [...labels, SENTINEL_LABELS.other]);
  if (!selected) return undefined;
  if (selected === SENTINEL_LABELS.other) {
    const customText = await ui.input?.(title, "");
    return customText ? { customText } : undefined;
  }
  return { value: selected };
}

function parseOptionText(
  options: PiAskOption[],
  text: string,
  type: Exclude<PiAskQuestionType, "freeform">,
): PiAskAnswerEntry {
  const parts = type === "multi" ? splitAnswerParts(text) : [text.trim()].filter(Boolean);
  const matched = parts
    .map((part) => findOption(options, part))
    .filter((option): option is PiAskOption => Boolean(option));
  const unmatched = parts.filter((part) => !findOption(options, part));
  if (type === "single") {
    const option = matched[0];
    if (option) return { values: [option.value], labels: [option.label] };
    return { values: [], labels: [], customText: text.trim() };
  }
  return {
    values: matched.map((option) => option.value),
    labels: matched.map((option) => option.label),
    customText: unmatched.length > 0 ? unmatched.join(", ") : undefined,
  };
}

function splitAnswerParts(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findOption(options: PiAskOption[], value: string): PiAskOption | undefined {
  return options.find((option) => option.label === value || option.value === value);
}

function requiresExplicitAskUserSelection(request: PiAskRequest, question: PiAskQuestion): boolean {
  return (
    (request.mode === "decision" || request.mode === "approval") &&
    question.required === true &&
    (question.type ?? "single") !== "freeform"
  );
}

function requestRequiresExplicitAskUserSelection(request: PiAskRequest): boolean {
  return request.questions.some((question) => requiresExplicitAskUserSelection(request, question));
}

function inferAskUserResultStatus(
  result: Pick<PiAskResult, "answers" | "cancelled">,
): PiAskResultStatus {
  if (result.cancelled) return "cancelled";
  return Object.keys(result.answers).length > 0 ? "answered" : "no_selection";
}

function summarizeResult(request: PiAskRequest, result: PiAskResult): string {
  if (result.status !== "answered") return `${request.title ?? "ask_user"}: ${result.status}`;
  const answered = Object.entries(result.answers).map(
    ([id, answer]) => `${id}=${answer.values.join(",") || answer.customText || ""}`,
  );
  return `${request.title ?? "ask_user"}: ${answered.join("; ") || "no answers"}`;
}

function renderToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: ToolCallRenderTheme,
): ToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const args = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new ToolCallText(`${title}${args}`.trimEnd());
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = needsQuoting(text) ? JSON.stringify(text) : text;
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? 80)}`;
}

function needsQuoting(value: string): boolean {
  return /\s|["'`]/.test(value);
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export * from "./schema.ts";
export * from "./flow.ts";
export { PiAskFlowPayloadStore } from "./ask-payload-store.ts";
export { createAskConfigStore } from "./config/store.ts";
export { PiAskFlowController } from "./ui/controller.ts";
export { createInitialState, buildExtendedOptions } from "./state/state.ts";
export type { AskState } from "./state/state.ts";
export { reduce } from "./state/reducer.ts";
export type { AskAction, Effect } from "./state/reducer.ts";
export { routeKey } from "./state/key-router.ts";
export { renderAskScreen } from "./ui/render.ts";
export type { RenderTheme, AskUILanguage } from "./ui/render.ts";
