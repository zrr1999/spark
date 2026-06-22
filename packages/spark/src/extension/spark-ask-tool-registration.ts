import { Type } from "typebox";
import { replaySparkAskTool, runSparkAskTool, type SparkAskToolParams } from "./spark-ask-tool.ts";
import type { ArtifactRef } from "@zendev-lab/pi-extension-api";
import { normalizeArtifactRef } from "./artifact-tools.ts";
import { sparkAskUi } from "./spark-ask-ui.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

export function normalizeSparkAskReplayArtifactRef(value: unknown): ArtifactRef | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeArtifactRef(value);
}

export function registerSparkAskTools(registerSparkTool: SparkToolRegistrar): void {
  registerSparkTool({
    name: "impl_ask",
    label: "Spark Ask",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock form and persist the answer as an artifact.",
    promptGuidelines: [
      "Use ask as the canonical ask tool; this implementation persists Spark ask artifacts.",
      "When user-facing open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, turn them into context-specific ask questions instead of leaving them as prose.",
      "Each option needs a stable id, short label, and clear description explaining what choosing it means.",
      "Use freeform questions for notes/context instead of creating business options named Other or Type your own.",
      "Do not use generic or template intake questions; ask only questions grounded in the inspected situation whose answers would change the next action or plan.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      title: Type.String({
        description: "Context-specific form title shown to the user.",
        minLength: 1,
      }),
      context: Type.Optional(
        Type.String({ description: "Additional context shown with the form." }),
      ),
      flow: Type.Optional(
        Type.String({ description: "Stable flow identifier for this context-specific ask." }),
      ),
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable question identifier used as result key." }),
          prompt: Type.String({ description: "Question shown to the user." }),
          header: Type.Optional(Type.String({ description: "Short tab/header label." })),
          type: Type.Optional(Type.String({ description: "single | multi | preview | freeform" })),
          required: Type.Optional(Type.Boolean()),
          defaultValues: Type.Optional(
            Type.Array(Type.String({ description: "Default selected option IDs." })),
          ),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                id: Type.String({ description: "Stable option ID returned in answers." }),
                label: Type.String({ description: "Short user-visible label." }),
                description: Type.String({
                  description:
                    "Required clear explanation of what choosing this option means; do not repeat only the id/label.",
                }),
                preview: Type.Optional(Type.String()),
              }),
            ),
          ),
        }),
        { minItems: 1 },
      ),
      behaviour: Type.Optional(
        Type.Object({
          allowElaborate: Type.Optional(Type.Boolean()),
          allowReplay: Type.Optional(Type.Boolean()),
          preservePriorAnswers: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runSparkAskTool(params as unknown as SparkAskToolParams, {
        cwd: ctx.cwd,
        ui: sparkAskUi(ctx),
      });
    },
  });

  registerSparkTool({
    name: "impl_ask_replay",
    label: "Spark Ask Replay",
    description:
      "Replay the latest Spark ask artifact, or a specified ask artifact, preserving prior answers where possible.",
    parameters: Type.Object({
      artifactRef: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return replaySparkAskTool({
        cwd: ctx.cwd,
        artifactRef: normalizeSparkAskReplayArtifactRef(params.artifactRef),
        ui: sparkAskUi(ctx),
      });
    },
  });
}
