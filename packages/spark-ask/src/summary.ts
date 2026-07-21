import type { SparkAskFlowAnswerEntry, SparkAskFlowRequest, SparkAskFlowResult } from "./schema.ts";
import { formatAskAnswerForDisplay } from "./shared-semantics.ts";

export interface AskSummaryAnswer {
  values: string[];
  labels?: string[];
  customText?: string;
  preview?: string;
}

export interface AskSummaryResult {
  status: "answered" | "pending" | "cancelled" | "no_selection";
  humanRequestId?: string;
  answers: Record<string, AskSummaryAnswer>;
  nextAction?: "resume" | "clarify_then_reask" | "block";
  mode?: string;
}

export interface AskSummaryRequest {
  title?: string;
  flow?: string;
  mode?: string;
}

export interface AskArtifactBody<Req = AskSummaryRequest, Res = AskSummaryResult> {
  request: Req;
  result: Res;
  summary: string;
}

export function summarizeAskResult(
  request: AskSummaryRequest,
  result: AskSummaryResult,
  options: { prefix?: string; blocked?: boolean } = {},
): string {
  const title = request.title ?? request.flow ?? options.prefix ?? "ask";
  const answerText = summarizeAskAnswers(result.answers);
  const blockedPrefix = options.blocked ? " blocked" : "";
  if (result.status === "pending") {
    return `${title}: pending${result.humanRequestId ? `; request=${result.humanRequestId}` : ""}`;
  }
  if (result.status !== "answered")
    return `${title}${blockedPrefix}: ${result.status}; ${answerText}`;
  const nextAction =
    result.nextAction && result.nextAction !== "resume" ? `; next=${result.nextAction}` : "";
  return `${title}${blockedPrefix}: answered; ${answerText}${nextAction}`;
}

export function summarizeAskAnswers(answers: Record<string, AskSummaryAnswer>): string {
  const entries = Object.entries(answers);
  if (entries.length === 0) return "no selection";
  if (entries.length === 1 && entries[0]?.[0] === "answer") {
    return formatAskAnswerForDisplay(entries[0][1]);
  }
  return entries.map(([id, answer]) => `${id}=${formatAskAnswerForDisplay(answer)}`).join("; ");
}

export function createAskArtifactBody<Req extends AskSummaryRequest, Res extends AskSummaryResult>(
  request: Req,
  result: Res,
  options: { blocked?: boolean } = {},
): AskArtifactBody<Req, Res> {
  return omitUndefinedFields({
    request,
    result,
    summary: summarizeAskResult(request, result, options),
  }) as AskArtifactBody<Req, Res>;
}

export function createSparkAskFlowArtifactBody(
  request: SparkAskFlowRequest,
  result: SparkAskFlowResult,
  options: { blocked?: boolean } = {},
): AskArtifactBody<SparkAskFlowRequest, SparkAskFlowResult> {
  return createAskArtifactBody(request, result, options);
}

export function isAskArtifactBody(value: unknown): value is AskArtifactBody {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "object" &&
    typeof (value as { result?: unknown }).result === "object" &&
    typeof (value as { summary?: unknown }).summary === "string",
  );
}

export function answerEntriesFromFlow(
  answers: Record<string, SparkAskFlowAnswerEntry>,
): Record<string, AskSummaryAnswer> {
  return answers;
}

function omitUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : omitUndefinedFields(item)));
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = omitUndefinedFields(child);
  }
  return result;
}
