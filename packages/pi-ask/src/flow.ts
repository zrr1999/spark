import { Type } from "typebox";

import { PiAskFlowController } from "./ui/controller.ts";
import { PiAskFlowPayloadStore } from "./ask-payload-store.ts";
import type {
  PiAskFlowAnswerEntry,
  PiAskFlowQuestion,
  PiAskFlowRequest,
  PiAskFlowResult,
} from "./schema.ts";
import { validatePiAskFlowRequest } from "./schema.ts";
import {
  createPiAskFlowArtifactBody as createSharedPiAskFlowArtifactBody,
  summarizeAskResult,
} from "./summary.ts";
import {
  defaultAskChoice,
  hasRequiredAskSelections,
  hasSubmittedRequiredAskAnswers,
  inferAskSubmitStatus,
  isGateMode,
  nextActionForAskSubmit,
  parseAskChoice,
  requiresExplicitSelectionForGate,
  selectOptionWithCustom,
  type ParsedAskChoice,
  type SelectWithCustomUi,
} from "./shared-semantics.ts";

interface PiExtensionAPI {
  registerTool?(config: {
    name: string;
    label?: string;
    description: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (
      toolCallId: unknown,
      params: unknown,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }): void;
  registerCommand?(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: unknown) => void | Promise<void>;
    },
  ): void;
}

interface PiAskFlowToolContext {
  cwd?: string;
  ui?: {
    custom?: (
      componentName: string,
      renderer: PiAskFlowCustomRenderer,
      options: { placement: "fullScreen" },
    ) => unknown;
  };
}

type PiAskFlowCustomRenderer = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: () => void,
) => unknown;

export interface PiAskFlowElaborationNote {
  questionId: string;
  note: string;
}

export interface PiAskFlowArtifactBody {
  request: PiAskFlowRequest;
  result: PiAskFlowResult;
}

export function createPiAskFlowRequest(input: PiAskFlowRequest): PiAskFlowRequest {
  const validation = validatePiAskFlowRequest(input);
  if (!validation.valid) {
    throw new Error(
      `invalid ask flow request: ${validation.error}${validation.details ? ` (${validation.details})` : ""}`,
    );
  }
  return input;
}

export async function runPiAskFlow(
  input: PiAskFlowRequest,
  ui?: SelectWithCustomUi,
): Promise<PiAskFlowResult> {
  const request = createPiAskFlowRequest(input);
  if (!ui?.select && !ui?.selectWithCustom && !ui?.input) return defaultPiAskFlowResult(request);

  const answers: Record<string, PiAskFlowAnswerEntry> = {};
  for (const question of request.questions ?? []) {
    if (question.type === "freeform") {
      const text = await ui.input?.(question.prompt);
      if (text !== undefined) {
        answers[question.id] = {
          questionId: question.id,
          kind: "custom",
          values: [],
          customText: text,
        };
      } else if (requiresExplicitSelection(request, question)) {
        return createNoSelectionPiAskFlowResult(request, answers);
      }
      continue;
    }

    if (question.options && question.options.length > 0) {
      const choice = await selectOptionWithCustom(ui, question.prompt, question.options);
      if (!choice) {
        if (requiresExplicitSelection(request, question)) {
          return createNoSelectionPiAskFlowResult(request, answers);
        }
        continue;
      }
      const answer = toFlowAnswer(
        question.id,
        parseAskChoice(question.options, choice.customText ?? choice.value ?? "", question.type),
      );
      answers[question.id] = answer;
      if (requiresExplicitSelection(request, question) && answer.values.length === 0) {
        return createNoSelectionPiAskFlowResult(request, answers);
      }
    }
  }

  return createPiAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
  });
}

export function defaultPiAskFlowResult(request: PiAskFlowRequest): PiAskFlowResult {
  if (requestRequiresExplicitSelection(request)) {
    return createNoSelectionPiAskFlowResult(request, {});
  }

  const answers: Record<string, PiAskFlowAnswerEntry> = {};
  for (const question of request.questions ?? []) {
    if (question.type === "freeform") {
      answers[question.id] = {
        questionId: question.id,
        kind: "custom",
        values: [],
        customText: "",
      };
      continue;
    }
    const answer = defaultAskChoice(question.options, question.type);
    if (!answer) continue;
    answers[question.id] = toFlowAnswer(question.id, answer);
  }
  return createPiAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
  });
}

export async function replayPiAskFlow(
  input: PiAskFlowRequest,
  prior: PiAskFlowResult | undefined,
  ui?: SelectWithCustomUi,
): Promise<PiAskFlowResult> {
  return runPiAskFlow(replayablePiAskFlow(input, prior), ui);
}

export function replayablePiAskFlow(
  input: PiAskFlowRequest,
  prior?: PiAskFlowResult,
): PiAskFlowRequest {
  if (!prior?.answers || !input.behaviour?.preservePriorAnswers) return input;
  const questions: PiAskFlowQuestion[] = (input.questions ?? []).map((question) => {
    const existing = prior.answers[question.id];
    if (!existing || question.type === "freeform") return question;
    const options = question.options?.map((option) => ({
      ...option,
      description: existing.values.includes(option.value)
        ? `${option.description ?? ""}${option.description ? "\n" : ""}Previously selected.`
        : option.description,
    }));
    return { ...question, options };
  });
  return { ...input, questions };
}

export function createPiAskFlowArtifactBody(
  request: PiAskFlowRequest,
  result: PiAskFlowResult,
): PiAskFlowArtifactBody & { summary: string } {
  return createSharedPiAskFlowArtifactBody(request, normalizePiAskFlowResult(result, request));
}

export function isPiAskFlowArtifactBody(value: unknown): value is PiAskFlowArtifactBody & {
  summary?: string;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "object" &&
    typeof (value as { result?: unknown }).result === "object",
  );
}

export function createElaborationResult(
  prior: PiAskFlowResult,
  notes: PiAskFlowElaborationNote[],
): PiAskFlowResult {
  return createPiAskFlowResult({
    ...prior,
    status: "answered",
    mode: "elaborate",
    cancelled: false,
    elaboration: {
      affectedQuestionIds: notes.map((note) => note.questionId),
      preservedAnswers: prior.answers,
      notes,
    },
    nextAction: "clarify_then_reask",
  });
}

export function registerPiAskFlowTool(pi: PiExtensionAPI): void {
  const payloadStore = new PiAskFlowPayloadStore();

  pi.registerTool?.({
    name: "ask_flow",
    label: "Ask Flow",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock flow.",
    promptGuidelines: [
      "Use ask_flow when a decision needs multiple related questions.",
      "Ask questions grounded in the actual situation; avoid generic intake templates.",
      "After a decision is confirmed, continue with the chosen action when clear.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      context: Type.Optional(Type.String()),
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
    }),

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const request = createPiAskFlowRequest(rawParams as PiAskFlowRequest);
      const context = decodePiAskFlowToolContext(ctx);
      const ui = context.ui;

      if (!ui?.custom) {
        const result = createPiAskFlowResult({
          answers: {},
          flow: request.flow,
          mode: "cancel",
          cancelled: true,
          status: "cancelled",
        });
        return {
          content: [{ type: "text" as const, text: summarizeFlowResult(result, request) }],
          details: { result, status: result.status, cancelled: true, mode: "cancel" },
        };
      }

      const custom = ui.custom;
      const cwd = requiredPiAskFlowCwd(context);

      const result = await new Promise<PiAskFlowResult>((resolve) => {
        const controller = new PiAskFlowController({ request, language: "en" });
        const cb: PiAskFlowCustomRenderer = (tui, theme, _keybindings, done) => {
          const view = controller.run(
            tui as Parameters<typeof controller.run>[0],
            theme as Parameters<typeof controller.run>[1],
            (flowResult: PiAskFlowResult) => {
              done();
              resolve(flowResult);
            },
          );
          return view;
        };
        custom("pi-ask-flow", cb, { placement: "fullScreen" });
      });

      const normalizedResult = normalizePiAskFlowResult(result, request);
      await payloadStore.save(cwd, { request, result: normalizedResult, timestamp: Date.now() });

      return {
        content: [{ type: "text" as const, text: summarizeFlowResult(normalizedResult, request) }],
        details: {
          result: normalizedResult,
          status: normalizedResult.status,
          cancelled: normalizedResult.cancelled,
          mode: normalizedResult.mode,
        },
      };
    },
  });
}

function decodePiAskFlowToolContext(ctx: unknown): PiAskFlowToolContext {
  return ctx && typeof ctx === "object" ? (ctx as PiAskFlowToolContext) : {};
}

function requiredPiAskFlowCwd(ctx: PiAskFlowToolContext): string {
  if (typeof ctx.cwd === "string" && ctx.cwd.trim()) return ctx.cwd;
  throw new Error("ask_flow fullscreen requires ctx.cwd to persist the latest ask payload.");
}

export function createPiAskFlowResult(
  input: Omit<PiAskFlowResult, "status" | "nextAction"> &
    Partial<Pick<PiAskFlowResult, "status" | "nextAction">>,
): PiAskFlowResult {
  const result = input;
  const status = result.status ?? inferPiAskFlowResultStatus(input);
  return {
    ...result,
    status,
    nextAction: result.nextAction ?? nextActionForPiAskFlowStatus(status, result.mode),
  };
}

export function normalizePiAskFlowResult(
  result: PiAskFlowResult,
  request?: PiAskFlowRequest,
): PiAskFlowResult {
  const normalized = createPiAskFlowResult(result);
  if (!request || !isGateMode(request.mode)) return normalized;

  const status =
    normalized.status === "no_selection" &&
    hasSubmittedRequiredGateAnswers(request, normalized.answers)
      ? "answered"
      : normalized.status;
  const blocked = isPiAskFlowGateBlocked({ ...normalized, status }, request);
  return {
    ...normalized,
    status,
    nextAction: blocked ? "block" : nextActionForPiAskFlowStatus(status, normalized.mode),
  };
}

export function isPiAskFlowGateBlocked(
  result: PiAskFlowResult,
  request: PiAskFlowRequest,
): boolean {
  return (
    isGateMode(request.mode) &&
    (result.status === "no_selection" ||
      result.status === "cancelled" ||
      !hasRequiredGateSelections(request, result.answers))
  );
}

function createNoSelectionPiAskFlowResult(
  request: PiAskFlowRequest,
  answers: Record<string, PiAskFlowAnswerEntry>,
): PiAskFlowResult {
  const status = inferAskSubmitStatus(request, answers);
  return createPiAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
    status,
    nextAction: nextActionForAskSubmit(request, answers, status),
  });
}

function toFlowAnswer(questionId: string, choice: ParsedAskChoice): PiAskFlowAnswerEntry {
  const answer: PiAskFlowAnswerEntry = {
    questionId,
    kind: choice.kind,
    values: choice.values,
  };
  if (choice.labels.length > 0) answer.labels = choice.labels;
  if (choice.customText !== undefined) answer.customText = choice.customText;
  if (choice.preview !== undefined) answer.preview = choice.preview;
  return answer;
}

function requiresExplicitSelection(
  request: PiAskFlowRequest,
  question: PiAskFlowQuestion,
): boolean {
  return requiresExplicitSelectionForGate(request.mode, question);
}

function requestRequiresExplicitSelection(request: PiAskFlowRequest): boolean {
  return (request.questions ?? []).some((question) => requiresExplicitSelection(request, question));
}

function hasSubmittedRequiredGateAnswers(
  request: PiAskFlowRequest,
  answers: Record<string, PiAskFlowAnswerEntry>,
): boolean {
  return hasSubmittedRequiredAskAnswers(request, answers);
}

function hasRequiredGateSelections(
  request: PiAskFlowRequest,
  answers: Record<string, PiAskFlowAnswerEntry>,
): boolean {
  return hasRequiredAskSelections(request, answers);
}

function inferPiAskFlowResultStatus(
  result: Pick<PiAskFlowResult, "answers" | "cancelled" | "mode">,
): PiAskFlowResult["status"] {
  if (result.cancelled || result.mode === "cancel") return "cancelled";
  if (Object.keys(result.answers).length > 0) return "answered";
  return "no_selection";
}

function nextActionForPiAskFlowStatus(
  status: PiAskFlowResult["status"],
  mode: PiAskFlowResult["mode"],
): PiAskFlowResult["nextAction"] {
  if (mode === "elaborate") return "clarify_then_reask";
  return status === "answered" ? "resume" : "block";
}

function summarizeFlowResult(result: PiAskFlowResult, request?: PiAskFlowRequest): string {
  return summarizeAskResult(request ?? { title: "Ask flow" }, result);
}
