/** Ask-flow normalization for native TUI interaction presentation. */

import type { SparkAskFlowRequest, SparkAskFlowResult } from "@zendev-lab/spark-ask";
import type { SparkInteractionRequest, SparkJsonObject } from "@zendev-lab/spark-protocol";

export function nativeAskFlowRequest(
  request: Extract<SparkInteractionRequest, { kind: "askFlow" }>,
): SparkAskFlowRequest {
  return {
    title: request.title,
    ...(request.prompt ? { context: request.prompt } : {}),
    ...(request.flow ? { flow: request.flow } : {}),
    ...(request.delivery ? { delivery: request.delivery } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    mode: request.mode,
    questions: request.questions.map((question) => {
      // The protocol permits choice-shaped questions with no business options.
      // The native Ask controller always owns a custom reply affordance, so
      // normalize those questions to freeform instead of rejecting the whole
      // interaction before the user can answer it.
      const customOnly = question.type !== "freeform" && question.options.length === 0;
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.header ? { header: question.header } : {}),
        type: customOnly ? "freeform" : question.type,
        required: question.required,
        defaultValues: customOnly ? [] : [...question.defaultValues],
        options: question.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          ...(option.preview ? { preview: option.preview } : {}),
        })),
      };
    }),
    ...(request.allowElaborate === undefined
      ? {}
      : { behaviour: { allowElaborate: request.allowElaborate } }),
  };
}

export function nativeAskAnswers(result: SparkAskFlowResult): SparkJsonObject {
  return Object.fromEntries(
    Object.entries(result.answers).map(([questionId, answer]) => [
      questionId,
      {
        values: [...answer.values],
        ...(answer.labels ? { labels: [...answer.labels] } : {}),
        ...(answer.customText !== undefined ? { customText: answer.customText } : {}),
        ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
        ...(answer.preview !== undefined ? { preview: answer.preview } : {}),
      },
    ]),
  );
}

export function nativeAskLanguage(): "zh" | "en" {
  const locale = `${process.env.LC_ALL ?? ""} ${process.env.LC_MESSAGES ?? ""} ${process.env.LANG ?? ""}`;
  return /(?:^|[._\s-])zh(?:[._\s-]|$)/iu.test(locale) ? "zh" : "en";
}
