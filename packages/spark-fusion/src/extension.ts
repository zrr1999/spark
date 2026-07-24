import type {
  SparkHostContext,
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-core";
import { callLeafOrDegrade } from "@zendev-lab/spark-core";
import { Type } from "typebox";
import {
  DEFAULT_FUSION_TIMEOUT_MS,
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_PANEL_MAX_TOKENS,
  MAX_FUSION_PANELS,
  MIN_FUSION_PANELS,
  deliberateSparkFusion,
} from "./deliberate.ts";
import type { FusionPanelInput, SparkFusionDeliberationRequest } from "./types.ts";

export interface SparkFusionExtensionApi {
  registerTool(config: ToolConfig): void;
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

export function createSparkFusionTool(): ToolConfig {
  return {
    name: "fusion",
    label: "Fusion",
    description:
      "Run bounded independent model opinions and a structured comparison; the active model remains the final writer.",
    promptGuidelines: [
      "Use fusion selectively for consequential ambiguity, competing hypotheses, or work that benefits from genuinely independent model perspectives; skip it for simple or already-settled tasks.",
      "Treat Fusion as advisory. Read its panel evidence, contradictions, blind spots, and answer outline, then verify important claims before writing the final answer yourself.",
      "Prefer the default same-session perspectives unless model diversity materially helps and the user-approved provider/data-egress policy permits explicit model overrides.",
      "A partial or failed result is not consensus. Preserve uncertainty and continue mechanically instead of inventing a synthesis.",
    ],
    policy: {
      effect: "read",
      executionMode: "sequential",
      domains: ["models", "deliberation"],
      phases: ["plan", "implement"],
      approval: "required",
    },
    parameters: Type.Object(
      {
        action: Type.Literal("deliberate"),
        question: Type.String({
          minLength: 1,
          maxLength: 12_000,
          description: "The exact question or decision for the panel to analyze.",
        }),
        context: Type.Optional(
          Type.String({
            maxLength: 48_000,
            description: "Bounded evidence or context shared with every panel and the judge.",
          }),
        ),
        panels: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
                perspective: Type.String({ minLength: 1, maxLength: 2_000 }),
                model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
              },
              { additionalProperties: false },
            ),
            { minItems: MIN_FUSION_PANELS, maxItems: MAX_FUSION_PANELS },
          ),
        ),
        judgeModel: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        panelMaxTokens: Type.Optional(Type.Integer({ minimum: 128, maximum: 8_192 })),
        judgeMaxTokens: Type.Optional(Type.Integer({ minimum: 128, maximum: 8_192 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 600_000 })),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      const panelCount = Array.isArray(args.panels) ? args.panels.length : 3;
      return renderCall(theme, `fusion action=deliberate panels=${panelCount}`);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action !== "deliberate") {
        throw new Error("fusion.action must be deliberate");
      }
      const sessionModel = modelRef(ctx as SparkHostContext);
      const request = toolRequest(params, signal, sessionModel);
      const result = await deliberateSparkFusion(request, {
        runLeaf: (leafRequest) => callLeafOrDegrade(ctx as SparkHostContext, leafRequest),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { ...result },
        ...(result.status === "failed" ? { isError: true } : {}),
      };
    },
  };
}

export function registerSparkFusionTool(api: SparkFusionExtensionApi): void {
  api.registerTool(createSparkFusionTool());
}

export default function sparkFusionExtension(api: SparkFusionExtensionApi): void {
  registerSparkFusionTool(api);
}

function toolRequest(
  params: Record<string, unknown>,
  signal: AbortSignal,
  sessionModel: string | undefined,
): SparkFusionDeliberationRequest {
  return {
    question: params.question as string,
    ...(params.context !== undefined ? { context: params.context as string } : {}),
    ...(params.panels !== undefined ? { panels: params.panels as FusionPanelInput[] } : {}),
    ...(params.judgeModel !== undefined ? { judgeModel: params.judgeModel as string } : {}),
    ...(params.panelMaxTokens !== undefined
      ? { panelMaxTokens: params.panelMaxTokens as number }
      : { panelMaxTokens: DEFAULT_PANEL_MAX_TOKENS }),
    ...(params.judgeMaxTokens !== undefined
      ? { judgeMaxTokens: params.judgeMaxTokens as number }
      : { judgeMaxTokens: DEFAULT_JUDGE_MAX_TOKENS }),
    ...(params.timeoutMs !== undefined
      ? { timeoutMs: params.timeoutMs as number }
      : { timeoutMs: DEFAULT_FUSION_TIMEOUT_MS }),
    ...(sessionModel ? { sessionModel } : {}),
    signal,
  };
}

function modelRef(ctx: SparkHostContext): string | undefined {
  const provider = ctx.model?.provider?.trim();
  const id = ctx.model?.id?.trim();
  return provider && id ? `${provider}/${id}` : undefined;
}

function renderCall(theme: ToolRenderTheme, text: string): ToolCallText {
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
