/**
 * Spark model selector — host-side state and keybinding glue for the native
 * spark-cli pi-tui host.
 *
 * This module intentionally keeps UI rendering at arm's length. It owns the
 * provider/model selection rules, persistence into SparkConfig, and concrete
 * keybinding handlers. The pi-tui SelectList wrapper lives in
 * `../tui/model-selector.ts` and can be injected through `picker` when the real
 * boot path wires Ctrl+L.
 */

import type { SparkConfig } from "./config.ts";
import { loadSparkConfig, saveSparkConfig } from "./config.ts";
import type { SparkKeybindingContext, SparkKeybindings } from "./keybindings.ts";
import type {
  ProviderConfig,
  ProviderModelDefinition,
  SparkActiveSelection,
  SparkProviderRegistry,
} from "./provider-registry.ts";

export const SPARK_MODEL_PICKER_BINDING_ID = "app.modelPicker";
export const SPARK_MODEL_CYCLE_NEXT_BINDING_ID = "app.modelCycle.next";
export const SPARK_MODEL_CYCLE_PREV_BINDING_ID = "app.modelCycle.prev";

export type SparkModelCycleDirection = "next" | "prev";

export interface SparkModelSelectorItem {
  value: string;
  providerName: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  description: string;
  active: boolean;
  reasoning: boolean;
}

export interface SparkModelProviderGroup {
  providerName: string;
  providerLabel: string;
  active: boolean;
  models: SparkModelSelectorItem[];
}

export interface SparkModelPickerState {
  providers: SparkModelProviderGroup[];
  items: SparkModelSelectorItem[];
  active?: SparkActiveSelection;
}

export type SparkModelPicker = (
  state: SparkModelPickerState,
  ctx?: SparkKeybindingContext,
) => SparkActiveSelection | null | undefined | Promise<SparkActiveSelection | null | undefined>;

export type SparkConfigLoader = () => SparkConfig | Promise<SparkConfig>;
export type SparkConfigSaver = (config: SparkConfig) => void | Promise<void>;

export interface SparkModelSelectorOptions {
  registry: SparkProviderRegistry;
  /** Pre-loaded config. If omitted, the selector lazily loads ~/.spark/config.json. */
  config?: SparkConfig;
  loadConfig?: SparkConfigLoader;
  saveConfig?: SparkConfigSaver;
  /** UI picker hook, typically backed by apps/spark-tui/src/tui/model-selector.ts. */
  picker?: SparkModelPicker;
}

export class SparkModelSelector {
  private readonly registry: SparkProviderRegistry;
  private readonly loadConfig: SparkConfigLoader;
  private readonly saveConfig: SparkConfigSaver;
  private picker?: SparkModelPicker;
  private config?: SparkConfig;

  constructor(options: SparkModelSelectorOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.loadConfig = options.loadConfig ?? loadSparkConfig;
    this.saveConfig = options.saveConfig ?? saveSparkConfig;
    this.picker = options.picker;
  }

  listProviderGroups(): SparkModelProviderGroup[] {
    const active = this.registry.getActive();
    return this.registry.listProviders().map((provider) => ({
      providerName: provider.name,
      providerLabel: provider.name,
      active: active?.providerName === provider.name,
      models: this.registry
        .listModelsFor(provider.name)
        .map((model) => toSelectorItem(provider, model, active)),
    }));
  }

  listItems(): SparkModelSelectorItem[] {
    return this.listProviderGroups().flatMap((provider) => provider.models);
  }

  getPickerState(): SparkModelPickerState {
    const providers = this.listProviderGroups();
    return {
      providers,
      items: providers.flatMap((provider) => provider.models),
      active: this.registry.getActive(),
    };
  }

  getActive(): SparkActiveSelection | undefined {
    return this.registry.getActive();
  }

  setPicker(picker: SparkModelPicker | undefined): void {
    this.picker = picker;
  }

  /**
   * Apply a selection, update the in-memory SparkConfig object, then persist it.
   * `SparkProviderRegistry.setActive` does all provider/model validation.
   */
  async select(selection: SparkActiveSelection): Promise<SparkActiveSelection> {
    this.registry.setActive(selection);
    const config = await this.getConfig();
    config.activeProvider = selection.providerName;
    config.activeModel = selection.modelId;
    await this.saveConfig(config);
    return { ...selection };
  }

  /**
   * Cycle within the currently active provider's model list. If there is no
   * active selection yet, pick the first registered provider/model.
   */
  async cycle(direction: SparkModelCycleDirection): Promise<SparkActiveSelection | undefined> {
    const target = this.resolveCycleTarget(direction) ?? this.firstSelection();
    if (!target) return undefined;
    return this.select(target);
  }

  /** Open the injected picker and persist the selected provider/model. */
  async openPicker(ctx?: SparkKeybindingContext): Promise<SparkActiveSelection | undefined> {
    if (!this.picker) return undefined;
    const result = await this.picker(this.getPickerState(), ctx);
    if (!result) return undefined;
    return this.select(result);
  }

  private resolveCycleTarget(
    direction: SparkModelCycleDirection,
  ): SparkActiveSelection | undefined {
    const active = this.registry.getActive();
    if (!active) return undefined;

    const models = this.registry.listModelsFor(active.providerName);
    if (models.length === 0) return undefined;

    const currentIndex = models.findIndex((model) => model.id === active.modelId);
    const step = direction === "next" ? 1 : -1;
    const nextIndex =
      currentIndex === -1
        ? direction === "next"
          ? 0
          : models.length - 1
        : mod(currentIndex + step, models.length);

    return { providerName: active.providerName, modelId: models[nextIndex]!.id };
  }

  private firstSelection(): SparkActiveSelection | undefined {
    const provider = this.registry.listProviders()[0];
    const model = provider?.models[0];
    if (!provider || !model) return undefined;
    return { providerName: provider.name, modelId: model.id };
  }

  private async getConfig(): Promise<SparkConfig> {
    if (!this.config) this.config = await this.loadConfig();
    return this.config;
  }
}

export interface SparkModelSelectorKeybindingOptions {
  notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
}

export function registerSparkModelSelectorKeybindings(
  keybindings: SparkKeybindings,
  selector: SparkModelSelector,
  options: SparkModelSelectorKeybindingOptions = {},
): void {
  keybindings.register({
    id: SPARK_MODEL_PICKER_BINDING_ID,
    defaultKey: "ctrl+l",
    description: "Open the model selector",
    handler: async (ctx) => {
      const selection = await selector.openPicker(ctx);
      if (selection) options.notify?.(formatSelection(selection), "info");
    },
  });

  keybindings.register({
    id: SPARK_MODEL_CYCLE_NEXT_BINDING_ID,
    defaultKey: "ctrl+p",
    description: "Cycle to the next model for the active provider",
    handler: async () => {
      const selection = await selector.cycle("next");
      if (selection) options.notify?.(formatSelection(selection), "info");
    },
  });

  keybindings.register({
    id: SPARK_MODEL_CYCLE_PREV_BINDING_ID,
    defaultKey: "shift+ctrl+p",
    description: "Cycle to the previous model for the active provider",
    handler: async () => {
      const selection = await selector.cycle("prev");
      if (selection) options.notify?.(formatSelection(selection), "info");
    },
  });
}

export function sparkModelSelectionValue(selection: SparkActiveSelection): string {
  return JSON.stringify([selection.providerName, selection.modelId]);
}

export function sparkModelSelectionFromValue(value: string): SparkActiveSelection {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw new Error(`Invalid Spark model selection value: ${value}`);
  }
  return { providerName: parsed[0], modelId: parsed[1] };
}

export function formatSelection(selection: SparkActiveSelection): string {
  return `Model: ${selection.providerName}/${selection.modelId}`;
}

function toSelectorItem(
  provider: ProviderConfig,
  model: ProviderModelDefinition,
  active: SparkActiveSelection | undefined,
): SparkModelSelectorItem {
  const selection = { providerName: provider.name, modelId: model.id };
  return {
    value: sparkModelSelectionValue(selection),
    providerName: provider.name,
    providerLabel: provider.name,
    modelId: model.id,
    modelLabel: appendCostSummary(model.name || model.id, model),
    description: describeModel(provider, model),
    active: active?.providerName === provider.name && active.modelId === model.id,
    reasoning: model.reasoning,
  };
}

function describeModel(provider: ProviderConfig, model: ProviderModelDefinition): string {
  const parts = [`${provider.name}/${model.id}`];
  const cost = formatCostDetails(model);
  if (cost) parts.push(cost);
  if (model.reasoning) parts.push("reasoning");
  parts.push(`${formatNumber(model.contextWindow)} ctx`);
  parts.push(`${formatNumber(model.maxTokens)} max`);
  return parts.join(" • ");
}

function appendCostSummary(label: string, model: ProviderModelDefinition): string {
  const summary = formatCostSummary(model);
  return summary ? `[${summary}] ${label}` : label;
}

function formatCostSummary(model: ProviderModelDefinition): string | undefined {
  const { input, output } = model.cost;
  if (!hasAnyCost(model)) return undefined;
  return `$${formatCostNumber(input)}/$${formatCostNumber(output)}/M`;
}

function formatCostDetails(model: ProviderModelDefinition): string | undefined {
  if (!hasAnyCost(model)) return undefined;
  const { input, output, cacheRead, cacheWrite } = model.cost;
  return `$${formatCostNumber(input)} in / $${formatCostNumber(output)} out / $${formatCostNumber(cacheRead)} read / $${formatCostNumber(cacheWrite)} write per 1M`;
}

function hasAnyCost(model: ProviderModelDefinition): boolean {
  const { input, output, cacheRead, cacheWrite } = model.cost;
  return [input, output, cacheRead, cacheWrite].some(
    (value) => Number.isFinite(value) && value > 0,
  );
}

function formatCostNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value)
    ? String(value)
    : String(value).replace(/0+$/, "").replace(/\.$/, "");
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
