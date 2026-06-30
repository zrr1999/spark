import { Type } from "typebox";
import type {
  ExtensionContext,
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/pi-extension-api";

export type PiAskAction = "ask" | "flow";
export type PiAskAutoAnswerMode = "reviewer";

export interface PiAskActionToolApi {
  registerTool(config: ToolConfig): void;
}

export interface PiAskActionToolOptions {
  resolveTool(name: "ask_user" | "ask_flow"): ToolConfig | undefined;
  autoAnswer?: PiAskAutoAnswerResolver;
}

export interface PiAskAutoAnswerRequest {
  title?: string;
  mode?: string;
  context?: string;
  flow?: string;
  questions: PiAskAutoAnswerQuestion[];
}

export interface PiAskAutoAnswerQuestion {
  id: string;
  prompt: string;
  header?: string;
  type?: string;
  required?: boolean;
  defaultValues?: string[];
  options?: PiAskAutoAnswerOption[];
}

export interface PiAskAutoAnswerOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface PiAskAutoAnswerEntry {
  values?: string[];
  customText?: string;
  notes?: string;
  comment?: string;
}

export interface PiAskAutoAnswerResult {
  answers?: Record<string, PiAskAutoAnswerEntry>;
  blocked?: boolean;
  reason?: string;
}

export type PiAskAutoAnswerResolver = (
  request: PiAskAutoAnswerRequest,
  ctx: ExtensionContext,
) => Promise<PiAskAutoAnswerResult> | PiAskAutoAnswerResult;

export type PiAskAutoAnswerProvider = (
  request: PiAskAutoAnswerRequest,
  ctx: ExtensionContext,
) => Promise<PiAskAutoAnswerResult | undefined> | PiAskAutoAnswerResult | undefined;

const AUTO_ANSWER_PROVIDER_REGISTRY_KEY = "__zendevLabPiAskAutoAnswerProviders";

type GlobalWithPiAskAutoAnswerProviders = typeof globalThis & {
  __zendevLabPiAskAutoAnswerProviders?: Map<string, PiAskAutoAnswerProvider>;
};

function autoAnswerProviderRegistry(): Map<string, PiAskAutoAnswerProvider> {
  const globalObject = globalThis as GlobalWithPiAskAutoAnswerProviders;
  globalObject[AUTO_ANSWER_PROVIDER_REGISTRY_KEY] ??= new Map();
  return globalObject[AUTO_ANSWER_PROVIDER_REGISTRY_KEY];
}

export function registerPiAskAutoAnswerProvider(
  id: string,
  provider: PiAskAutoAnswerProvider,
): () => void {
  const providers = autoAnswerProviderRegistry();
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) providers.delete(id);
  };
}

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [
      this.text.length > width ? `${this.text.slice(0, Math.max(0, width - 1))}…` : this.text,
    ];
  }
}

export function registerPiAskActionTool(
  pi: PiAskActionToolApi,
  options: PiAskActionToolOptions,
): void {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Canonical ask capability. Use action=ask for a structured user ask; action=flow forces the fullscreen multi-question ask_flow renderer. autoAnswer=reviewer is an explicit host-provided mode for reviewer-backed decisions; ordinary asks do not auto-answer.",
    promptGuidelines: [
      "Use ask as the canonical user-question tool instead of choosing between ask_user and ask_flow directly.",
      "Ask only context-specific questions whose answers change the next action, plan, dependency, priority, or success criteria.",
      "Use freeform questions for notes/context; do not create business options named Other or Type your own.",
      "Do not set autoAnswer unless the active host policy explicitly asks for reviewer-backed decisions.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "ask | flow. Defaults to ask." })),
      autoAnswer: Type.Optional(
        Type.String({
          description:
            "Optional explicit auto-answer mode. Only reviewer is supported, and only when the host injected an auto-answer resolver.",
        }),
      ),
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      context: Type.Optional(Type.String()),
      flow: Type.Optional(Type.String({ description: "Stable flow identifier for ask_flow." })),
      questions: Type.Array(
        Type.Object({
          id: Type.String(),
          prompt: Type.String(),
          header: Type.Optional(Type.String()),
          type: Type.Optional(Type.String({ description: "single | multi | preview | freeform" })),
          required: Type.Optional(Type.Boolean()),
          defaultValues: Type.Optional(Type.Array(Type.String())),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                value: Type.String(),
                label: Type.String(),
                description: Type.Optional(Type.String()),
                preview: Type.Optional(Type.String()),
              }),
            ),
          ),
        }),
      ),
      behaviour: Type.Optional(
        Type.Object({
          allowElaborate: Type.Optional(Type.Boolean()),
          allowReplay: Type.Optional(Type.Boolean()),
          preservePriorAnswers: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderAskCall(args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeAskAction(params.action);
      const autoAnswer = normalizeAskAutoAnswerMode(
        params.autoAnswer ?? contextAutoAnswerMode(ctx),
      );
      const target = selectAskTarget(action, params);
      const tool = options.resolveTool(target);
      if (!tool) throw new Error(`ask action adapter could not find ${target}`);
      const forwarded = stripAdapterOnlyParams(params);
      if (!autoAnswer) return tool.execute(toolCallId, forwarded, signal, onUpdate, ctx);
      const request = decodeAutoAnswerRequest(params);
      const resolver = options.autoAnswer ?? contextAutoAnswerResolver(ctx);
      const autoAnswered = resolver
        ? await resolver(request, ctx)
        : await resolveAutoAnswerFromProviders(request, ctx);
      if (!autoAnswered) return blockedAutoAnswerResult(params, missingAutoAnswerResolverReason());
      const blocked = validateAutoAnswerResult(request, autoAnswered);
      if (blocked) return blockedAutoAnswerResult(params, blocked);
      const syntheticCtx = withSyntheticAutoAnswerUi(ctx, request, autoAnswered.answers ?? {});
      const result = await tool.execute(toolCallId, forwarded, signal, onUpdate, syntheticCtx);
      return annotateAutoAnswerResult(result, autoAnswered);
    },
  });
}

function normalizeAskAction(value: unknown): PiAskAction {
  if (value === undefined || value === null || value === "ask") return "ask";
  if (value === "flow") return "flow";
  throw new Error("ask.action must be ask or flow");
}

function normalizeAskAutoAnswerMode(value: unknown): PiAskAutoAnswerMode | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === "reviewer") return "reviewer";
  throw new Error("ask.autoAnswer must be reviewer when provided");
}

function contextAutoAnswerMode(ctx: ExtensionContext): unknown {
  return (ctx as { askAutoAnswer?: unknown }).askAutoAnswer;
}

function contextAutoAnswerResolver(ctx: ExtensionContext): PiAskAutoAnswerResolver | undefined {
  const resolver = (ctx as { askAutoAnswerResolver?: unknown }).askAutoAnswerResolver;
  return typeof resolver === "function" ? (resolver as PiAskAutoAnswerResolver) : undefined;
}

async function resolveAutoAnswerFromProviders(
  request: PiAskAutoAnswerRequest,
  ctx: ExtensionContext,
): Promise<PiAskAutoAnswerResult | undefined> {
  for (const provider of autoAnswerProviderRegistry().values()) {
    const answer = await provider(request, ctx);
    if (answer) return answer;
  }
  return undefined;
}

function selectAskTarget(
  action: PiAskAction,
  params: Record<string, unknown>,
): "ask_user" | "ask_flow" {
  if (action === "flow") return "ask_flow";
  if (typeof params.flow === "string" && params.flow.trim()) return "ask_flow";
  if (params.behaviour !== undefined) return "ask_flow";
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length !== 1) return "ask_flow";
  const [question] = questions as Array<Record<string, unknown>>;
  if (question?.header !== undefined || question?.type === "preview") return "ask_flow";
  if (Array.isArray(question?.options) && question.options.some((option) => hasPreview(option))) {
    return "ask_flow";
  }
  return "ask_user";
}

function stripAdapterOnlyParams(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, autoAnswer: _autoAnswer, ...rest } = params;
  return rest;
}

function hasPreview(value: unknown): boolean {
  return typeof value === "object" && value !== null && "preview" in value;
}

function decodeAutoAnswerRequest(params: Record<string, unknown>): PiAskAutoAnswerRequest {
  return {
    title: optionalString(params.title),
    mode: optionalString(params.mode),
    context: optionalString(params.context),
    flow: optionalString(params.flow),
    questions: Array.isArray(params.questions)
      ? params.questions.map((question) => decodeAutoAnswerQuestion(question))
      : [],
  };
}

function decodeAutoAnswerQuestion(value: unknown): PiAskAutoAnswerQuestion {
  const raw = isRecord(value) ? value : {};
  return {
    id: optionalString(raw.id) ?? "",
    prompt: optionalString(raw.prompt) ?? "",
    header: optionalString(raw.header),
    type: optionalString(raw.type),
    required: raw.required === true,
    defaultValues: stringArray(raw.defaultValues),
    options: Array.isArray(raw.options)
      ? raw.options.map((option) => decodeAutoAnswerOption(option))
      : undefined,
  };
}

function decodeAutoAnswerOption(value: unknown): PiAskAutoAnswerOption {
  const raw = isRecord(value) ? value : {};
  return {
    value: optionalString(raw.value) ?? "",
    label: optionalString(raw.label) ?? "",
    description: optionalString(raw.description),
    preview: optionalString(raw.preview),
  };
}

function validateAutoAnswerResult(
  request: PiAskAutoAnswerRequest,
  result: PiAskAutoAnswerResult,
): string | undefined {
  if (result.blocked) return result.reason || "reviewer auto-answer blocked";
  const answers = result.answers ?? {};
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  for (const [questionId, answer] of Object.entries(answers)) {
    const question = questions.get(questionId);
    if (!question) return `reviewer answered unknown question ${questionId}`;
    const values = answer.values ?? [];
    if ((question.type ?? "single") === "freeform") continue;
    const allowed = new Set((question.options ?? []).map((option) => option.value));
    for (const value of values) {
      if (!allowed.has(value))
        return `reviewer answer for ${questionId} used invalid option ${value}`;
    }
    if ((question.type ?? "single") !== "multi" && values.length > 1)
      return `reviewer answer for ${questionId} selected multiple values for a single-choice question`;
    if (values.length === 0 && !answer.customText)
      return `reviewer answer for ${questionId} did not provide a value or custom text`;
  }
  return undefined;
}

function withSyntheticAutoAnswerUi(
  ctx: ExtensionContext,
  request: PiAskAutoAnswerRequest,
  answers: Record<string, PiAskAutoAnswerEntry>,
): ExtensionContext {
  let index = 0;
  const nextQuestion = () => request.questions[index++];
  const ui = {
    select: async () => labelChoice(nextQuestion(), answers),
    selectWithCustom: async () => selectionChoice(nextQuestion(), answers),
    input: async () => freeformChoice(nextQuestion(), answers),
  };
  return {
    ...(isRecord(ctx) ? ctx : {}),
    ui: { ...(isRecord(ctx) && isRecord(ctx.ui) ? ctx.ui : {}), ...ui },
  };
}

function selectionChoice(
  question: PiAskAutoAnswerQuestion | undefined,
  answers: Record<string, PiAskAutoAnswerEntry>,
): { value?: string; customText?: string } | undefined {
  if (!question) return undefined;
  const answer = answers[question.id];
  if (!answer) return undefined;
  if (answer.customText !== undefined) return { customText: answer.customText };
  const labels = labelsForValues(question, answer.values ?? []);
  return labels.length > 0 ? { value: labels.join(", ") } : undefined;
}

function labelChoice(
  question: PiAskAutoAnswerQuestion | undefined,
  answers: Record<string, PiAskAutoAnswerEntry>,
): string | undefined {
  if (!question) return undefined;
  const answer = answers[question.id];
  if (!answer) return undefined;
  if (answer.customText !== undefined) return answer.customText;
  return labelsForValues(question, answer.values ?? []).join(", ") || undefined;
}

function freeformChoice(
  question: PiAskAutoAnswerQuestion | undefined,
  answers: Record<string, PiAskAutoAnswerEntry>,
): string | undefined {
  if (!question) return undefined;
  const answer = answers[question.id];
  return answer?.customText ?? answer?.notes ?? answer?.comment;
}

function labelsForValues(question: PiAskAutoAnswerQuestion, values: string[]): string[] {
  const byValue = new Map((question.options ?? []).map((option) => [option.value, option.label]));
  return values.flatMap((value) => {
    const label = byValue.get(value);
    return label ? [label] : [];
  });
}

function missingAutoAnswerResolverReason(): string {
  return [
    "ask autoAnswer=reviewer cannot run because this tool call did not receive a host-provided reviewer auto-answer resolver.",
    "Spark injects that resolver only for active goal turns and deliberately clears it for /implement or ordinary manual asks.",
    "Start or resume a goal and run the goal turn, or omit autoAnswer=reviewer for a normal user-facing ask.",
    "If a session goal is already active and this still appears, the Spark goal ask-auto-answer policy did not attach its resolver to the current tool context.",
  ].join(" ");
}

function blockedAutoAnswerResult(params: Record<string, unknown>, reason: string) {
  const request = decodeAutoAnswerRequest(params);
  return {
    content: [{ type: "text" as const, text: `Ask auto-answer blocked: ${reason}` }],
    details: {
      request,
      result: { status: "no_selection", cancelled: false, answers: {}, nextAction: "block" },
      autoAnswered: false,
      blocked: true,
      error: "auto_answer_blocked",
      reason,
    },
    isError: true,
  };
}

function annotateAutoAnswerResult(
  result: Awaited<ReturnType<ToolConfig["execute"]>>,
  autoAnswered: PiAskAutoAnswerResult,
) {
  return {
    ...result,
    details: {
      ...(isRecord(result.details) ? result.details : {}),
      autoAnswered: true,
      autoAnswer: { mode: "reviewer", reason: autoAnswered.reason },
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function renderAskCall(args: Record<string, unknown>, theme: ToolRenderTheme): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "ask";
  const title = typeof args.title === "string" ? args.title : undefined;
  const questionCount = Array.isArray(args.questions) ? `${args.questions.length}q` : undefined;
  const autoAnswer = args.autoAnswer === "reviewer" ? "auto=reviewer" : undefined;
  const text = ["ask", `action=${action}`, autoAnswer, title, questionCount]
    .filter(Boolean)
    .join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
