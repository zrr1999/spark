import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Usage,
} from "@earendil-works/pi-ai";

import type { SparkConfig } from "./config.ts";
import type {
  ProviderConfig,
  ProviderModelDefinition,
  SparkProviderRegistry,
} from "./provider-registry.ts";

export const SPARK_FUSION_PROVIDER = "spark-fusion";
export const SPARK_FUSION_MODEL = "spark-fusion";
export const DEFAULT_SPARK_FUSION_PANEL_SIZE = 3;

export interface SparkFusionModelSelection {
  provider: string;
  model: string;
}

export interface SparkFusionConfig {
  /** Expert panel. Defaults to the first available non-fusion models. */
  analysisModels?: SparkFusionModelSelection[];
  /** Judge/synthesis model. Defaults to the first panel model. */
  judgeModel?: SparkFusionModelSelection;
  /** Maximum number of panel models when analysisModels is omitted. Defaults to 3. */
  panelSize?: number;
}

export interface SparkFusionRunConfig {
  analysisModels: SparkFusionModelSelection[];
  judgeModel: SparkFusionModelSelection;
}

interface FusionPanelResult {
  selection: SparkFusionModelSelection;
  text: string;
  usage?: Usage;
  error?: string;
}

export function registerSparkFusionProvider(
  registry: SparkProviderRegistry,
  config: SparkConfig = { extensions: [], providers: [] },
): void {
  registry.registerProvider(SPARK_FUSION_PROVIDER, createSparkFusionProvider(registry, config));
}

export function createSparkFusionProvider(
  registry: SparkProviderRegistry,
  config: SparkConfig,
): ProviderConfig {
  return {
    name: SPARK_FUSION_PROVIDER,
    baseUrl: "spark://fusion",
    api: "spark-fusion",
    streamSimple: (model, context, options) =>
      streamSparkFusion(registry, config, model, context, options),
    models: [SPARK_FUSION_MODEL_DEFINITION],
  };
}

export function resolveSparkFusionRunConfig(
  registry: SparkProviderRegistry,
  config: SparkConfig,
): SparkFusionRunConfig {
  const available = listAvailableFusionTargets(registry);
  if (available.length === 0) {
    throw new Error("Spark Fusion requires at least one non-fusion provider model");
  }

  const configuredPanel = (config.fusion?.analysisModels ?? [])
    .filter(isValidSelectionShape)
    .filter((selection) => hasModel(registry, selection));
  const panelSize = normalizedPanelSize(config.fusion?.panelSize);
  const analysisModels = uniqueSelections(
    configuredPanel.length > 0 ? configuredPanel : available.slice(0, panelSize),
  );
  if (analysisModels.length === 0) {
    throw new Error("Spark Fusion could not resolve any analysis models");
  }

  const configuredJudge = config.fusion?.judgeModel;
  const judgeModel =
    configuredJudge && isValidSelectionShape(configuredJudge) && hasModel(registry, configuredJudge)
      ? configuredJudge
      : analysisModels[0]!;

  return { analysisModels, judgeModel };
}

export function listAvailableFusionTargets(
  registry: SparkProviderRegistry,
): SparkFusionModelSelection[] {
  const selections: SparkFusionModelSelection[] = [];
  for (const provider of registry.listProviders()) {
    if (provider.name === SPARK_FUSION_PROVIDER) continue;
    for (const model of provider.models) {
      selections.push({ provider: provider.name, model: model.id });
    }
  }
  return selections;
}

export function streamSparkFusion(
  registry: SparkProviderRegistry,
  config: SparkConfig,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void runSparkFusion(registry, config, model, context, options, stream);
  return stream;
}

export async function runSparkFusion(
  registry: SparkProviderRegistry,
  config: SparkConfig,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const output = createAssistant(model, []);
  stream.push({ type: "start", partial: output });

  try {
    const runConfig = resolveSparkFusionRunConfig(registry, config);
    const prompt = extractLatestUserText(context);
    const panelResults = await Promise.all(
      runConfig.analysisModels.map((selection) =>
        runPanelModel(registry, selection, context, prompt, options),
      ),
    );
    const judge = await runJudgeModel(
      registry,
      runConfig.judgeModel,
      context,
      prompt,
      panelResults,
      options,
    );
    const judgeText = assistantMessageToText(judge);
    const finalText = judgeText.trim() || fallbackSynthesis(panelResults);

    const textPart: TextContent = { type: "text", text: finalText };
    output.content.push(textPart);
    output.usage = sumUsage(panelResults, judge.usage);
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    stream.push({ type: "text_delta", contentIndex: 0, delta: finalText, partial: output });
    stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: output });
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end(output);
  } catch (error) {
    output.stopReason = "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: "error", error: output });
    stream.end(output);
  }
}

async function runPanelModel(
  registry: SparkProviderRegistry,
  selection: SparkFusionModelSelection,
  originalContext: Context,
  prompt: string,
  options?: SimpleStreamOptions,
): Promise<FusionPanelResult> {
  try {
    const assistant = await completeSelection(
      registry,
      selection,
      buildPanelContext(originalContext, prompt),
      options,
    );
    return { selection, text: assistantMessageToText(assistant), usage: assistant.usage };
  } catch (error) {
    return { selection, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function runJudgeModel(
  registry: SparkProviderRegistry,
  selection: SparkFusionModelSelection,
  originalContext: Context,
  prompt: string,
  panelResults: FusionPanelResult[],
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return completeSelection(
    registry,
    selection,
    buildJudgeContext(originalContext, prompt, panelResults),
    options,
  );
}

async function completeSelection(
  registry: SparkProviderRegistry,
  selection: SparkFusionModelSelection,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const provider = registry.getProvider(selection.provider);
  if (!provider) throw new Error(`Unknown Spark Fusion provider: ${selection.provider}`);
  const model = registry.buildModel(selection.provider, selection.model);
  const stream = provider.streamSimple(model, context, options) as AssistantMessageEventStream;
  for await (const _event of stream) {
    void _event;
  }
  return await stream.result();
}

function buildPanelContext(originalContext: Context, prompt: string): Context {
  return {
    systemPrompt: [
      originalContext.systemPrompt,
      "You are one expert in a Spark Fusion-style multi-model panel.",
      "Answer the user's latest request independently. Be concise, evidence-oriented, and mention uncertainty or assumptions. Do not call tools.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    messages: [
      ...conversationPrefix(originalContext.messages),
      { role: "user", content: prompt, timestamp: Date.now() },
    ],
    tools: [],
  };
}

function buildJudgeContext(
  originalContext: Context,
  prompt: string,
  panelResults: FusionPanelResult[],
): Context {
  return {
    systemPrompt: [
      originalContext.systemPrompt,
      "You are the judge in a Spark Fusion-style multi-model deliberation.",
      "Compare the panel responses, then write the final answer for the user. Prefer consensus, call out contradictions only when useful, preserve unique correct insights, and do not invent unavailable evidence.",
      "Return the final user-facing answer directly; do not include hidden analysis JSON unless the user asked for it.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    messages: [
      ...conversationPrefix(originalContext.messages),
      {
        role: "user",
        content: renderJudgePrompt(prompt, panelResults),
        timestamp: Date.now(),
      },
    ],
    tools: [],
  };
}

function renderJudgePrompt(prompt: string, panelResults: FusionPanelResult[]): string {
  const renderedResults = panelResults
    .map((result, index) => {
      const label = `${result.selection.provider}/${result.selection.model}`;
      if (result.error) return `## Panel ${index + 1}: ${label}\nERROR: ${result.error}`;
      return `## Panel ${index + 1}: ${label}\n${result.text || "(empty response)"}`;
    })
    .join("\n\n");

  return [
    "Original user request:",
    prompt,
    "",
    "Panel responses:",
    renderedResults,
    "",
    "Synthesize a final answer. Use this comparison checklist internally: consensus, contradictions, coverage gaps, unique insights, and blind spots.",
  ].join("\n");
}

function extractLatestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== "user") continue;
    return userContentToText(message.content).trim();
  }
  return "";
}

function conversationPrefix(messages: Message[]): Message[] {
  const prefix: Message[] = [];
  for (const message of messages.slice(0, -1)) {
    if (message.role === "toolResult") continue;
    if (message.role === "assistant") {
      const content = message.content.filter((part) => part.type !== "toolCall");
      if (content.length > 0) prefix.push({ ...message, content });
      continue;
    }
    prefix.push(message);
  }
  return prefix;
}

function userContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ((part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      if ((part as { type?: unknown }).type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantMessageToText(message: AssistantMessage): string {
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return "";
      if (part.type === "toolCall") return `[tool call: ${part.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function fallbackSynthesis(panelResults: FusionPanelResult[]): string {
  const successful = panelResults.filter((result) => result.text.trim());
  if (successful[0]) return successful[0].text;
  const errors = panelResults.filter((result) => result.error).map((result) => result.error);
  return errors.length > 0
    ? `Spark Fusion failed: ${errors.join("; ")}`
    : "Spark Fusion produced no output.";
}

function createAssistant(
  model: Model<Api>,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function sumUsage(panelResults: FusionPanelResult[], judgeUsage: Usage | undefined): Usage {
  const usage = emptyUsage();
  for (const result of panelResults) {
    if (result.usage) addUsage(usage, result.usage);
  }
  if (judgeUsage) addUsage(usage, judgeUsage);
  return usage;
}

function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
}

function hasModel(registry: SparkProviderRegistry, selection: SparkFusionModelSelection): boolean {
  if (selection.provider === SPARK_FUSION_PROVIDER) return false;
  return registry.listModelsFor(selection.provider).some((model) => model.id === selection.model);
}

function isValidSelectionShape(value: unknown): value is SparkFusionModelSelection {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as SparkFusionModelSelection).provider === "string" &&
    typeof (value as SparkFusionModelSelection).model === "string" &&
    (value as SparkFusionModelSelection).provider.length > 0 &&
    (value as SparkFusionModelSelection).model.length > 0
  );
}

function uniqueSelections(selections: SparkFusionModelSelection[]): SparkFusionModelSelection[] {
  const seen = new Set<string>();
  const out: SparkFusionModelSelection[] = [];
  for (const selection of selections) {
    const key = selectionKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(selection);
  }
  return out;
}

function selectionKey(selection: SparkFusionModelSelection): string {
  return `${selection.provider}\0${selection.model}`;
}

function normalizedPanelSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SPARK_FUSION_PANEL_SIZE;
  return Math.min(Math.max(Math.floor(value), 1), 8);
}

const SPARK_FUSION_MODEL_DEFINITION: ProviderModelDefinition = {
  id: SPARK_FUSION_MODEL,
  name: "Spark Fusion (multi-model deliberation)",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_000,
};
