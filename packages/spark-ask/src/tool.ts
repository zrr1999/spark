import { PiAskFlowController, createAskArtifactBody, summarizeAskResult } from "pi-ask";
import { defaultArtifactStore } from "spark-artifacts";
import type { ArtifactRef, JsonValue } from "spark-core";

import {
  createSparkAskRequest,
  isSparkAskArtifactBody,
  isSparkAskGateBlocked,
  normalizeSparkAskResult,
  replaySparkAsk,
  runSparkAsk,
  type SparkAskBehaviour,
  type SparkAskQuestionTypeVal,
  type SparkAskRequest,
  type SparkAskResult,
} from "./index.ts";

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
  type?: SparkAskQuestionTypeVal;
  required?: boolean;
  defaultValues?: string[];
  options?: SparkAskToolOptionParams[];
}

export interface SparkAskToolParams {
  kind?: string;
  mode?: string;
  title?: string;
  context?: string;
  flow?: string;
  questions?: SparkAskToolQuestionParams[];
  behaviour?: SparkAskBehaviour;
  /** Legacy single-question shape. Prefer `questions[]`. */
  question?: string;
  /** Legacy single-question options. Prefer `questions[].options`. */
  options?: SparkAskToolOptionParams[];
  /** Legacy single-question multi-select flag. Prefer `questions[].type = "multi"`. */
  multiSelect?: boolean;
  defaultOptionId?: string;
}

export type SparkAskToolUi = NonNullable<Parameters<typeof runSparkAsk>[1]> & {
  custom?: (...args: unknown[]) => unknown;
};

export function createSparkAskToolRequest(params: SparkAskToolParams): SparkAskRequest {
  const questions = normalizeSparkAskToolQuestions(params);
  const title = params.title?.trim() || params.question?.trim();
  if (!title) throw new Error("spark_ask requires a context-specific title or question");
  return createSparkAskRequest({
    flow: params.flow ?? "custom",
    mode: normalizeSparkAskMode(params.mode ?? params.kind),
    title,
    context: params.context,
    questions,
    behaviour: {
      allowElaborate: true,
      allowReplay: true,
      preservePriorAnswers: true,
      ...params.behaviour,
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
    : (await store.list({ kind: "ask-answer" })).slice(-1)[0];
  if (!artifact) {
    return {
      content: [{ type: "text", text: "No replayable ask artifact found." }],
      details: { found: false },
    };
  }
  if (!isSparkAskArtifactBody(artifact.body)) {
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
  const result = normalizeSparkAskResult(await replaySparkAsk(request, prior, input.ui), request);
  const blocked = isSparkAskGateBlocked(result, request);
  const body = createAskArtifactBody(request, result, { blocked });
  const replayArtifact = await store.put({
    kind: "ask-answer",
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
  request: SparkAskRequest,
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
  const result = normalizeSparkAskResult(await runSparkAskToolRequest(request, input.ui), request);
  const blocked = isSparkAskGateBlocked(result, request);
  const body = createAskArtifactBody(request, result, { blocked });
  const artifact = await defaultArtifactStore(input.cwd).put({
    kind: "ask-answer",
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
  result: SparkAskResult;
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
  request: SparkAskRequest,
  ui: SparkAskToolUi | undefined,
): Promise<SparkAskResult> {
  if (ui?.custom) {
    const fullscreenResult = await runSparkAskFullscreen(request, ui.custom);
    if (fullscreenResult) return fullscreenResult;
  }
  return runSparkAsk(request, ui);
}

async function runSparkAskFullscreen(
  request: SparkAskRequest,
  custom: NonNullable<SparkAskToolUi["custom"]>,
): Promise<SparkAskResult | undefined> {
  let factoryStarted = false;
  let resolveDone!: (result: SparkAskResult) => void;
  const doneResult = new Promise<SparkAskResult>((resolve) => {
    resolveDone = resolve;
  });
  const controller = new PiAskFlowController({ request, language: "en" });
  const factory = (
    tui: unknown,
    theme: unknown,
    _keybindings: unknown,
    done: (result: SparkAskResult) => void,
  ) => {
    factoryStarted = true;
    return controller.run(tui, theme as Parameters<typeof controller.run>[1], (flowResult) => {
      done(flowResult);
      resolveDone(flowResult);
    });
  };
  const maybeResult = custom(factory);
  if (!isThenable(maybeResult)) return factoryStarted ? doneResult : undefined;

  return Promise.race([
    doneResult,
    maybeResult.then((result) => (isSparkAskResultLike(result) ? result : undefined)),
  ]);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof (value as Promise<unknown>).then === "function");
}

function isSparkAskResultLike(value: unknown): value is SparkAskResult {
  return Boolean(value && typeof value === "object" && "answers" in value && "status" in value);
}

function normalizeSparkAskToolQuestions(params: SparkAskToolParams): SparkAskRequest["questions"] {
  const rawQuestions = params.questions;
  if (rawQuestions && rawQuestions.length > 0) {
    return rawQuestions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      header: question.header,
      type: question.type,
      required: question.required,
      defaultValues: normalizeDefaultValues(question.defaultValues),
      options:
        question.type === "freeform"
          ? undefined
          : normalizeSparkAskToolOptions(question.options, question.id),
    }));
  }

  if (!params.question) {
    throw new Error("spark_ask requires questions[] or a legacy question field");
  }

  return [
    {
      id: "answer",
      prompt: params.question,
      type: params.multiSelect === true ? "multi" : "single",
      options: normalizeSparkAskToolOptions(params.options, "answer"),
      required: true,
      defaultValues: normalizeDefaultValues(
        params.defaultOptionId ? [params.defaultOptionId] : undefined,
      ),
    },
  ];
}

function normalizeDefaultValues(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSparkAskToolOptions(
  rawOptions: SparkAskToolOptionParams[] | undefined,
  questionId: string,
): SparkAskRequest["questions"][number]["options"] {
  if (!rawOptions || rawOptions.length < 2) {
    throw new Error(
      `spark_ask question ${questionId} requires at least two clear, detailed options`,
    );
  }

  const seenIds = new Set<string>();
  return rawOptions.map((option, index) => {
    const position = index + 1;
    const id = option.id.trim();
    const label = option.label.trim();
    const description = option.description.trim();
    if (!id)
      throw new Error(`spark_ask question ${questionId} option ${position} needs a non-empty id`);
    if (!label) throw new Error(`spark_ask option ${id} needs a non-empty label`);
    if (seenIds.has(id))
      throw new Error(`spark_ask question ${questionId} option id is duplicated: ${id}`);
    seenIds.add(id);
    if (description.length < MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH) {
      throw new Error(
        `spark_ask option ${id} needs a clearer description (at least ${MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH} characters explaining what choosing it means)`,
      );
    }
    if (sameNormalizedText(description, id) || sameNormalizedText(description, label)) {
      throw new Error(`spark_ask option ${id} description must explain more than the id/label`);
    }
    return {
      value: id,
      label,
      description,
      preview: option.preview,
    };
  });
}

function sameNormalizedText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeSparkAskMode(
  kind: unknown,
): "clarification" | "decision" | "approval" | "unblock" | undefined {
  if (kind === "clarification" || kind === "decision" || kind === "approval" || kind === "unblock")
    return kind;
  return undefined;
}
