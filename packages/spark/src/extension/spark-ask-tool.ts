import { defaultArtifactStore } from "spark-artifacts";
import { type JsonValue } from "spark-core";
import {
  createSparkAskRequest,
  isSparkAskGateBlocked,
  normalizeSparkAskResult,
  runSparkAsk,
  type SparkAskRequest,
} from "spark-ask";

export const MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH = 12;

export interface SparkAskToolParams {
  kind?: string;
  question: string;
  options?: Array<{ id: string; label: string; description: string; preview?: string }>;
  multiSelect?: boolean;
}

export type SparkAskToolUi = Parameters<typeof runSparkAsk>[1];

export function createSparkAskToolRequest(params: SparkAskToolParams): SparkAskRequest {
  const options = normalizeSparkAskToolOptions(params.options);
  return createSparkAskRequest({
    flow: "custom",
    mode: isSparkAskKind(params.kind) ? params.kind : undefined,
    title: params.question,
    questions: [
      {
        id: "answer",
        prompt: params.question,
        type: params.multiSelect === true ? "multi" : "single",
        options,
        required: true,
      },
    ],
    behaviour: {
      allowElaborate: true,
      allowReplay: true,
      preservePriorAnswers: true,
    },
  });
}

export async function runSparkAskTool(
  params: SparkAskToolParams,
  input: { cwd: string; ui: SparkAskToolUi },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const request = createSparkAskToolRequest(params);
  const result = normalizeSparkAskResult(await runSparkAsk(request, input.ui), request);
  const artifact = await defaultArtifactStore(input.cwd).put({
    kind: "ask-answer",
    title: `Ask answer: ${request.title ?? "custom ask"}`,
    format: "json",
    body: { request, result } as unknown as JsonValue,
    provenance: { producer: "ask" },
  });
  const answer = result.answers.answer;
  const blocked = isSparkAskGateBlocked(result, request);
  return {
    content: [
      {
        type: "text",
        text: blocked
          ? `Ask blocked (${result.status}): no decision/approval selection (${artifact.ref})`
          : `Ask ${result.status}: ${answer?.values.join(", ") || answer?.customText || "no selection"} (${artifact.ref})`,
      },
    ],
    details: {
      request: request as unknown as Record<string, unknown>,
      result: result as unknown as Record<string, unknown>,
      status: result.status,
      blocked,
      artifactRef: artifact.ref,
    },
  };
}

function normalizeSparkAskToolOptions(
  rawOptions: SparkAskToolParams["options"],
): SparkAskRequest["questions"][number]["options"] {
  if (!rawOptions || rawOptions.length < 2) {
    throw new Error("spark_ask requires at least two clear, detailed options");
  }

  const seenIds = new Set<string>();
  return rawOptions.map((option, index) => {
    const position = index + 1;
    const id = option.id.trim();
    const label = option.label.trim();
    const description = option.description.trim();
    if (!id) throw new Error(`spark_ask option ${position} needs a non-empty id`);
    if (!label) throw new Error(`spark_ask option ${id} needs a non-empty label`);
    if (seenIds.has(id)) throw new Error(`spark_ask option id is duplicated: ${id}`);
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

function isSparkAskKind(
  kind: unknown,
): kind is "clarification" | "decision" | "approval" | "unblock" {
  return (
    kind === "clarification" || kind === "decision" || kind === "approval" || kind === "unblock"
  );
}
