import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";

import { PiAskFlowController } from "./ui/controller.ts";
import { createAskConfigStore } from "./config/store.ts";
import { PiAskFlowPayloadStore } from "./ask-payload-store.ts";
import type {
  PiAskFlowAnswerEntry,
  PiAskFlowQuestion,
  PiAskFlowRequest,
  PiAskFlowResult,
} from "./schema.ts";
import { SENTINEL_LABELS, validatePiAskFlowRequest } from "./schema.ts";

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
  ui?: { select?: Function; selectWithCustom?: Function; confirm?: Function; input?: Function },
): Promise<PiAskFlowResult> {
  const request = createPiAskFlowRequest(input);
  if (!ui?.select && !ui?.selectWithCustom) return defaultPiAskFlowResult(request);

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
      const choice = await selectFlowQuestionOptionWithCustom(
        ui,
        question.prompt,
        question.options,
      );
      if (!choice) {
        if (requiresExplicitSelection(request, question)) {
          return createNoSelectionPiAskFlowResult(request, answers);
        }
        continue;
      }
      const answer = parseFlowChoice(question, choice.customText ?? choice.value ?? "");
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
    const first = question.options?.[0];
    if (!first) continue;
    answers[question.id] = {
      questionId: question.id,
      kind: question.type === "multi" ? "multi" : "option",
      values: [first.value],
      labels: [first.label],
      preview: first.preview,
    };
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
  ui?: { select?: Function; selectWithCustom?: Function; input?: Function },
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
): PiAskFlowArtifactBody {
  return { request, result: normalizePiAskFlowResult(result, request) };
}

export function isPiAskFlowArtifactBody(value: unknown): value is PiAskFlowArtifactBody {
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
  const configStore = createAskConfigStore();
  const config = configStore.load();
  const payloadStore = new PiAskFlowPayloadStore();

  pi.registerTool?.({
    name: "ask_flow",
    label: "Ask Flow",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock flow.",
    promptGuidelines: [
      "Use ask_flow when a decision needs multiple related questions.",
      "Ask focused questions and avoid broad intake forms.",
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
      const ui = (ctx as Record<string, unknown>).ui as
        | { custom?: (...args: unknown[]) => unknown }
        | undefined;

      if (!ui?.custom) {
        const result = createPiAskFlowResult({
          answers: {},
          flow: request.flow,
          mode: "cancel",
          cancelled: true,
          status: "cancelled",
        });
        return {
          content: [{ type: "text" as const, text: summarizeFlowResult(result) }],
          details: { result, status: result.status, cancelled: true, mode: "cancel" },
        };
      }

      const cwd =
        typeof (ctx as Record<string, unknown>).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();

      const result = await new Promise<PiAskFlowResult>((resolve) => {
        const controller = new PiAskFlowController({ request, language: "en" });
        const cb = (tui: unknown, theme: unknown, _keybindings: unknown, done: () => void) => {
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
        (ui.custom as Function)("pi-ask-flow", cb, { placement: "fullScreen" });
      });

      const normalizedResult = normalizePiAskFlowResult(result, request);
      await payloadStore.save(cwd, { request, result: normalizedResult, timestamp: Date.now() });

      return {
        content: [{ type: "text" as const, text: summarizeFlowResult(normalizedResult) }],
        details: {
          result: normalizedResult as unknown as Record<string, unknown>,
          status: normalizedResult.status,
          cancelled: normalizedResult.cancelled,
          mode: normalizedResult.mode,
        },
      };
    },
  });

  pi.registerCommand?.("ask-settings", {
    description: "Open Pi ask settings",
    async handler(_args: string, ctx: unknown) {
      const raw = ctx as Record<string, unknown>;
      const ui = raw.ui as { select?: Function; notify?: Function; confirm?: Function } | undefined;
      if (!ui?.select) return;

      const choice = await ui.select("Pi Ask Settings", [
        "View config path",
        "Toggle auto-submit",
        "Toggle confirm-dismiss",
        "Reset to defaults",
        "<- Back",
      ]);
      if (!choice || choice === "<- Back") return;

      if (choice === "View config path") {
        ui.notify?.(
          `Config: ${join(homedir(), ".pi", "agent", "extensions", "pi-ask.json")}`,
          "info",
        );
      } else if (choice === "Toggle auto-submit") {
        config.behaviour.autoSubmitWhenAnsweredWithoutNotes =
          !config.behaviour.autoSubmitWhenAnsweredWithoutNotes;
        configStore.save(config);
        ui.notify?.(
          `Auto-submit ${config.behaviour.autoSubmitWhenAnsweredWithoutNotes ? "enabled" : "disabled"}`,
          "success",
        );
      } else if (choice === "Toggle confirm-dismiss") {
        config.behaviour.confirmDismissWhenDirty = !config.behaviour.confirmDismissWhenDirty;
        configStore.save(config);
        ui.notify?.(
          `Confirm-dismiss ${config.behaviour.confirmDismissWhenDirty ? "enabled" : "disabled"}`,
          "success",
        );
      } else if (choice === "Reset to defaults") {
        const confirmed = await ui.confirm?.(
          "Reset all pi-ask settings?",
          "This cannot be undone.",
        );
        if (confirmed) {
          const defaults = createAskConfigStore().load();
          Object.assign(config, defaults);
          configStore.save(config);
          ui.notify?.("Settings reset to defaults", "success");
        }
      }
    },
  });
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
  if (!request || !isGateRequest(request)) return normalized;

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
    isGateRequest(request) &&
    (result.status === "no_selection" ||
      result.status === "cancelled" ||
      !hasRequiredGateSelections(request, result.answers))
  );
}

function createNoSelectionPiAskFlowResult(
  request: PiAskFlowRequest,
  answers: Record<string, PiAskFlowAnswerEntry>,
): PiAskFlowResult {
  const status = hasSubmittedRequiredGateAnswers(request, answers) ? "answered" : "no_selection";
  return createPiAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
    status,
    nextAction: hasRequiredGateSelections(request, answers) ? undefined : "block",
  });
}

interface FlowSelectWithCustomResult {
  value?: string;
  customText?: string;
}

async function selectFlowQuestionOptionWithCustom(
  ui: { select?: Function; selectWithCustom?: Function; input?: Function },
  prompt: string,
  options: NonNullable<PiAskFlowQuestion["options"]>,
): Promise<FlowSelectWithCustomResult | undefined> {
  const labels = options.map((option) => option.label);
  if (ui.selectWithCustom) {
    const selected = await ui.selectWithCustom(prompt, {
      options: labels,
      customLabel: SENTINEL_LABELS.other,
    });
    if (!selected) return undefined;
    if (typeof selected === "string") return { value: selected };
    return selected;
  }
  const selected = await ui.select?.(prompt, [...labels, SENTINEL_LABELS.other]);
  if (!selected) return undefined;
  if (selected === SENTINEL_LABELS.other) {
    const customText = await ui.input?.(prompt, "");
    return customText ? { customText } : undefined;
  }
  return { value: selected };
}

function parseFlowChoice(question: PiAskFlowQuestion, choice: string): PiAskFlowAnswerEntry {
  const questionType = question.type ?? "single";
  const parts =
    questionType === "multi" ? splitChoiceParts(choice) : [choice.trim()].filter(Boolean);
  const matched = parts
    .map((part) => question.options?.find((entry) => entry.label === part || entry.value === part))
    .filter((option): option is NonNullable<PiAskFlowQuestion["options"]>[number] =>
      Boolean(option),
    );
  const unmatched = parts.filter(
    (part) => !question.options?.some((entry) => entry.label === part || entry.value === part),
  );

  if (questionType === "multi") {
    return {
      questionId: question.id,
      kind: "multi",
      values: matched.map((option) => option.value),
      labels: matched.map((option) => option.label),
      customText: unmatched.length > 0 ? unmatched.join(", ") : undefined,
      preview: matched.length === 1 ? matched[0]?.preview : undefined,
    };
  }

  const option = matched[0];
  if (option) {
    return {
      questionId: question.id,
      kind: "option",
      values: [option.value],
      labels: [option.label],
      preview: option.preview,
    };
  }

  return {
    questionId: question.id,
    kind: "custom",
    values: [],
    customText: choice.trim(),
  };
}

function splitChoiceParts(choice: string): string[] {
  return choice
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function requiresExplicitSelection(
  request: PiAskFlowRequest,
  question: PiAskFlowQuestion,
): boolean {
  return (
    (request.mode === "decision" || request.mode === "approval") &&
    question.required === true &&
    question.type !== "freeform"
  );
}

function requestRequiresExplicitSelection(request: PiAskFlowRequest): boolean {
  return (request.questions ?? []).some((question) => requiresExplicitSelection(request, question));
}

function isGateRequest(request: PiAskFlowRequest): boolean {
  return request.mode === "decision" || request.mode === "approval";
}

function requiredGateQuestions(request: PiAskFlowRequest): PiAskFlowQuestion[] {
  return (request.questions ?? []).filter((question) =>
    requiresExplicitSelection(request, question),
  );
}

function hasSubmittedRequiredGateAnswers(
  request: PiAskFlowRequest,
  answers: Record<string, PiAskFlowAnswerEntry>,
): boolean {
  const questions = requiredGateQuestions(request);
  if (questions.length === 0) return Object.keys(answers).length > 0;
  return questions.every((question) => Boolean(answers[question.id]));
}

function hasRequiredGateSelections(
  request: PiAskFlowRequest,
  answers: Record<string, PiAskFlowAnswerEntry>,
): boolean {
  const questions = requiredGateQuestions(request);
  if (questions.length === 0) return Object.keys(answers).length > 0;
  return questions.every((question) => (answers[question.id]?.values.length ?? 0) > 0);
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

function summarizeFlowResult(result: PiAskFlowResult): string {
  const answered = Object.entries(result.answers).map(
    ([id, answer]) => `${id}=${answer.values.join(",") || answer.customText || ""}`,
  );
  if (result.status !== "answered") {
    return `Ask flow ${result.status}: ${answered.join("; ") || "no answers"}`;
  }
  return `Ask flow ${result.mode}: ${answered.join("; ") || "no answers"}`;
}
