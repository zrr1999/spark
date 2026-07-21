/**
 * ask tool runner.
 *
 * Source content was previously routed through `spark-ask` (a thin facade over
 * `spark-ask`); now lives directly in `spark/extension` and consumes spark-ask
 * primitives by their original names. Spark-prefixed type names are kept
 * because these wrappers are spark-specific (artifact persistence + replay
 * through Spark artifact store + the `ask` tool name).
 */

import {
  SparkAskFlowController,
  createAskArtifactBody,
  createSparkAskFlowRequest,
  createSparkAskFlowResult,
  isSparkAskFlowArtifactBody,
  isSparkAskFlowGateBlocked,
  isSparkAskFlowResultLike,
  normalizeSparkAskFlowResult,
  replaySparkAskFlow,
  runSparkAskFlow,
  summarizeAskResult,
  type SparkAskFlowBehaviour,
  type SparkAskFlowQuestionTypeVal,
  type SparkAskFlowRequest,
  type SparkAskFlowResult,
} from "@zendev-lab/spark-ask";
import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import type { ArtifactRef, JsonValue } from "@zendev-lab/spark-core";

export const MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH = 12;

export interface SparkAskToolOptionParams {
  id: string;
  label: string;
  description: string;
  preview?: string;
}

export interface SparkAskToolQuestionParams {
  id: string;
  prompt: string;
  header?: string;
  type?: SparkAskFlowQuestionTypeVal;
  required?: boolean;
  defaultValues?: string[];
  options?: SparkAskToolOptionParams[];
}

export interface SparkAskToolParams {
  mode?: string;
  title?: string;
  context?: string;
  flow?: string;
  questions: SparkAskToolQuestionParams[];
  behaviour?: SparkAskFlowBehaviour;
}

export const DEFAULT_SPARK_ASK_CUSTOM_UI_TIMEOUT_MS = 60_000;

export type SparkAskToolUi = NonNullable<Parameters<typeof runSparkAskFlow>[1]> & {
  custom?: (...args: unknown[]) => unknown;
  /** Wall-clock timeout for custom fullscreen ask UI completion. Defaults to 60s; <=0 disables. */
  customTimeoutMs?: number;
};

export function createSparkAskToolRequest(params: SparkAskToolParams): SparkAskFlowRequest {
  const questions = normalizeSparkAskToolQuestions(params);
  const title = normalizeSparkAskToolString(params.title, "title");
  if (!title) throw new Error("ask requires a context-specific title");
  return createSparkAskFlowRequest({
    flow: normalizeSparkAskToolString(params.flow, "flow") ?? "custom",
    mode: normalizeSparkAskMode(params.mode),
    title,
    context: normalizeSparkAskToolString(params.context, "context"),
    questions,
    behaviour: {
      allowElaborate: true,
      allowReplay: true,
      preservePriorAnswers: true,
      ...normalizeSparkAskBehaviour(params.behaviour),
    },
  });
}

export async function runSparkAskTool(
  params: SparkAskToolParams,
  input: { cwd: string; ui?: SparkAskToolUi },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const request = createSparkAskToolRequest(params);
  return runAndPersistSparkAskRequest(request, {
    cwd: input.cwd,
    ui: input.ui,
    title: `Ask answer: ${request.title ?? "custom ask"}`,
    contentText: ({ summary, artifactRef }) => `${summary} (${artifactRef})`,
  });
}

export async function replaySparkAskTool(input: {
  cwd: string;
  artifactRef?: ArtifactRef;
  ui?: SparkAskToolUi;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const store = defaultArtifactStore(input.cwd);
  const artifact = input.artifactRef
    ? await store.get(input.artifactRef)
    : (await store.list({ producer: "ask" })).slice(-1)[0];
  if (!artifact) {
    return {
      content: [{ type: "text", text: "No replayable ask artifact found." }],
      details: { found: false },
    };
  }
  if (!isSparkAskFlowArtifactBody(artifact.body)) {
    return {
      content: [
        {
          type: "text",
          text: `Artifact ${artifact.ref} is not a Spark ask artifact.`,
        },
      ],
      details: { found: true, replayable: false },
    };
  }

  const request = artifact.body.request;
  const prior = artifact.body.result;
  const result = normalizeSparkAskFlowResult(
    await replaySparkAskFlow(request, prior, input.ui),
    request,
  );
  const blocked = isSparkAskFlowGateBlocked(result, request);
  const body = createAskArtifactBody(request, result, { blocked });
  const replayArtifact = await store.put({
    kind: "record",
    title: `Replay ask: ${request.title ?? request.flow}`,
    format: "json",
    body: body as unknown as JsonValue,
    provenance: { producer: "ask", parentArtifactRefs: [artifact.ref] },
  });
  const summary = summarizeAskResult(request, result, { blocked });
  return {
    content: [
      {
        type: "text",
        text: blocked
          ? `Replay blocked (${result.status}): no decision/approval selection (${replayArtifact.ref})`
          : `Replayed ask ${result.status} saved to ${replayArtifact.ref}`,
      },
    ],
    details: sparkAskToolDetails({
      artifactRef: replayArtifact.ref,
      result,
      blocked,
      summary,
    }),
  };
}

async function runAndPersistSparkAskRequest(
  request: SparkAskFlowRequest,
  input: {
    cwd: string;
    ui?: SparkAskToolUi;
    title: string;
    contentText: (input: { summary: string; artifactRef: ArtifactRef }) => string;
  },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const result = normalizeSparkAskFlowResult(
    await runSparkAskToolRequest(request, input.ui),
    request,
  );
  const blocked = isSparkAskFlowGateBlocked(result, request);
  const body = createAskArtifactBody(request, result, { blocked });
  const artifact = await defaultArtifactStore(input.cwd).put({
    kind: "record",
    title: input.title,
    format: "json",
    body: body as unknown as JsonValue,
    provenance: { producer: "ask" },
  });
  const summary = summarizeAskResult(request, result, { blocked });
  return {
    content: [
      {
        type: "text",
        text: input.contentText({ summary, artifactRef: artifact.ref }),
      },
    ],
    details: sparkAskToolDetails({
      artifactRef: artifact.ref,
      result,
      blocked,
      summary,
    }),
  };
}

function sparkAskToolDetails(input: {
  artifactRef: ArtifactRef;
  result: SparkAskFlowResult;
  blocked: boolean;
  summary: string;
}): Record<string, unknown> {
  return {
    artifactRef: input.artifactRef,
    status: input.result.status,
    blocked: input.blocked,
    summary: input.summary,
    nextAction: input.result.nextAction,
    answers: input.result.answers as unknown as Record<string, unknown>,
  };
}

async function runSparkAskToolRequest(
  request: SparkAskFlowRequest,
  ui: SparkAskToolUi | undefined,
): Promise<SparkAskFlowResult> {
  if (ui?.custom) {
    const fullscreenResult = await runSparkAskFullscreen(request, ui.custom, ui.customTimeoutMs);
    if (fullscreenResult) return fullscreenResult;
  }
  return runSparkAskFlow(request, ui);
}

async function runSparkAskFullscreen(
  request: SparkAskFlowRequest,
  custom: NonNullable<SparkAskToolUi["custom"]>,
  timeoutMs: number | undefined,
): Promise<SparkAskFlowResult | undefined> {
  let factoryStarted = false;
  let resolveDone!: (result: SparkAskFlowResult) => void;
  const doneResult = new Promise<SparkAskFlowResult>((resolve) => {
    resolveDone = resolve;
  });
  const controller = new SparkAskFlowController({ request, language: "en" });
  const factory = (
    tui: unknown,
    theme: unknown,
    _keybindings: unknown,
    done: (result: SparkAskFlowResult) => void,
  ) => {
    factoryStarted = true;
    return controller.run(
      tui as Parameters<typeof controller.run>[0],
      theme as Parameters<typeof controller.run>[1],
      (flowResult) => {
        done(flowResult);
        resolveDone(flowResult);
      },
    );
  };
  const maybeResult = custom(factory);
  if (!isThenable(maybeResult)) {
    return factoryStarted
      ? runSparkAskFullscreenWithTimeout(doneResult, request, timeoutMs)
      : undefined;
  }

  return runSparkAskFullscreenWithTimeout(
    Promise.race([
      doneResult,
      maybeResult.then((result) => (isSparkAskFlowResultLike(result) ? result : undefined)),
    ]),
    request,
    timeoutMs,
  );
}

async function runSparkAskFullscreenWithTimeout(
  result: Promise<SparkAskFlowResult | undefined>,
  request: SparkAskFlowRequest,
  timeoutMs: number | undefined,
): Promise<SparkAskFlowResult | undefined> {
  const normalizedTimeoutMs = normalizeSparkAskCustomUiTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs <= 0) return await result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<SparkAskFlowResult>((resolve) => {
        timer = setTimeout(() => {
          resolve(createSparkAskCustomUiTimeoutResult(request));
        }, normalizedTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createSparkAskCustomUiTimeoutResult(request: SparkAskFlowRequest): SparkAskFlowResult {
  return createSparkAskFlowResult({
    answers: {},
    flow: request.flow,
    mode: "cancel",
    cancelled: true,
    status: "cancelled",
  });
}

function normalizeSparkAskCustomUiTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_SPARK_ASK_CUSTOM_UI_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) return DEFAULT_SPARK_ASK_CUSTOM_UI_TIMEOUT_MS;
  const normalized = Math.floor(timeoutMs);
  return normalized > 0 ? normalized : 0;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof (value as Promise<unknown>).then === "function");
}

function normalizeSparkAskToolQuestions(
  params: SparkAskToolParams,
): SparkAskFlowRequest["questions"] {
  const rawQuestions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("ask requires a non-empty questions[] array");
  }

  return rawQuestions.map((rawQuestion, index) => {
    const position = index + 1;
    if (!isRecord(rawQuestion)) throw new Error(`ask question ${position} must be an object`);
    const id = normalizeRequiredSparkAskToolString(rawQuestion.id, `question ${position} id`);
    const type = normalizeSparkAskQuestionType(rawQuestion.type, id);
    const rawOptions = rawQuestion.options;
    if (type === "freeform" && rawOptions !== undefined && rawOptions !== null) {
      throw new Error(`ask question ${id} freeform questions must not include options`);
    }
    return {
      id,
      prompt: normalizeRequiredSparkAskToolString(rawQuestion.prompt, `question ${id} prompt`),
      header: normalizeSparkAskToolString(rawQuestion.header, `question ${id} header`),
      type,
      required: normalizeSparkAskToolBoolean(rawQuestion.required, `question ${id} required`),
      defaultValues: normalizeDefaultValues(rawQuestion.defaultValues, id),
      options: type === "freeform" ? undefined : normalizeSparkAskToolOptions(rawOptions, id),
    };
  });
}

function normalizeDefaultValues(values: unknown, questionId: string): string[] | undefined {
  if (values === undefined || values === null) return undefined;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`ask question ${questionId} defaultValues must be a string array`);
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSparkAskToolOptions(
  rawOptions: unknown,
  questionId: string,
): SparkAskFlowRequest["questions"][number]["options"] {
  if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
    throw new Error(`ask question ${questionId} requires at least two clear, detailed options`);
  }

  const seenIds = new Set<string>();
  return rawOptions.map((option, index) => {
    const position = index + 1;
    if (!isRecord(option))
      throw new Error(`ask question ${questionId} option ${position} must be an object`);
    const id = normalizeRequiredSparkAskToolString(
      option.id,
      `question ${questionId} option ${position} id`,
    );
    const label = normalizeRequiredSparkAskToolString(
      option.label,
      `question ${questionId} option ${id} label`,
    );
    const description = normalizeRequiredSparkAskToolString(
      option.description,
      `question ${questionId} option ${id} description`,
    );
    if (seenIds.has(id))
      throw new Error(`ask question ${questionId} option id is duplicated: ${id}`);
    seenIds.add(id);
    if (description.length < MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH) {
      throw new Error(
        `ask option ${id} needs a clearer description (at least ${MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH} characters explaining what choosing it means)`,
      );
    }
    if (sameNormalizedText(description, id) || sameNormalizedText(description, label)) {
      throw new Error(`ask option ${id} description must explain more than the id/label`);
    }
    const preview = normalizeSparkAskToolString(
      option.preview,
      `question ${questionId} option ${id} preview`,
    );
    return {
      value: id,
      label,
      description,
      preview,
    };
  });
}

function sameNormalizedText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeSparkAskMode(
  mode: unknown,
): "clarification" | "decision" | "approval" | "unblock" | undefined {
  if (mode === undefined || mode === null) return undefined;
  if (mode === "clarification" || mode === "decision" || mode === "approval" || mode === "unblock")
    return mode;
  throw new Error("ask mode must be clarification, decision, approval, or unblock");
}

function normalizeSparkAskQuestionType(
  type: unknown,
  questionId: string,
): SparkAskFlowQuestionTypeVal | undefined {
  if (type === undefined || type === null) return undefined;
  if (type === "single" || type === "multi" || type === "preview" || type === "freeform")
    return type;
  throw new Error(`ask question ${questionId} type must be single, multi, preview, or freeform`);
}

function normalizeSparkAskBehaviour(value: unknown): SparkAskFlowBehaviour | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("ask behaviour must be an object");
  return {
    allowElaborate: normalizeSparkAskToolBoolean(value.allowElaborate, "behaviour.allowElaborate"),
    allowReplay: normalizeSparkAskToolBoolean(value.allowReplay, "behaviour.allowReplay"),
    preservePriorAnswers: normalizeSparkAskToolBoolean(
      value.preservePriorAnswers,
      "behaviour.preservePriorAnswers",
    ),
  };
}

function normalizeSparkAskToolBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`ask ${field} must be a boolean`);
  return value;
}

function normalizeSparkAskToolString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`ask ${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRequiredSparkAskToolString(value: unknown, field: string): string {
  const normalized = normalizeSparkAskToolString(value, field);
  if (!normalized) throw new Error(`ask ${field} must be a non-empty string`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
