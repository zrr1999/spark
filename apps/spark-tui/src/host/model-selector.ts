/**
 * Spark model selector — host-side state and keybinding glue for the native
 * spark-cli pi-tui host.
 *
 * This module intentionally keeps UI rendering at arm's length. It owns the
 * model-id selection rules, persistence into SparkConfig, and concrete
 * keybinding handlers. Provider/route remains internal routing detail. The
 * pi-tui SelectList wrapper lives in `../tui/model-selector.ts` and can be
 * injected through `picker` when the real boot path wires Ctrl+L.
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
  activeModelId?: string;
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
    const active = this.registry.getActive();
    return {
      providers,
      items: providers.flatMap((provider) => provider.models),
      active,
      activeModelId: active ? sparkModelSelectionValue(active) : undefined,
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
    const active = this.registry.getActive() ?? selection;
    const config = await this.getConfig();
    config.activeModelId = sparkModelSelectionValue(active);
    delete config.activeProvider;
    delete config.activeModel;
    await this.saveConfig(config);
    return { ...active };
  }

  /**
   * Cycle across the flattened Spark model id list. If there is no active
   * selection yet, pick the first registered model.
   */
  async cycle(direction: SparkModelCycleDirection): Promise<SparkActiveSelection | undefined> {
    const target = this.resolveCycleTarget(direction) ?? this.firstSelection();
    if (!target) return undefined;
    return this.select(target);
  }

  /** Open the injected picker and persist the selected model id. */
  async openPicker(ctx?: SparkKeybindingContext): Promise<SparkActiveSelection | undefined> {
    const result = await this.pick(this.getPickerState(), ctx);
    if (!result) return undefined;
    return this.select(result);
  }

  /** Render the host picker without mutating config. Daemon-backed adapters use this. */
  async pick(
    state: SparkModelPickerState = this.getPickerState(),
    ctx?: SparkKeybindingContext,
  ): Promise<SparkActiveSelection | undefined> {
    if (!this.picker) return undefined;
    return (await this.picker(state, ctx)) ?? undefined;
  }

  private resolveCycleTarget(
    direction: SparkModelCycleDirection,
  ): SparkActiveSelection | undefined {
    const items = this.listItems();
    if (items.length === 0) return undefined;
    const active = this.registry.getActive();
    const activeModelId = active ? sparkModelSelectionValue(active) : undefined;
    const currentIndex = activeModelId
      ? items.findIndex((item) => item.value === activeModelId)
      : -1;
    const step = direction === "next" ? 1 : -1;
    const nextIndex =
      currentIndex === -1
        ? direction === "next"
          ? 0
          : items.length - 1
        : mod(currentIndex + step, items.length);

    return selectionFromItem(items[nextIndex]!);
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
    description: "Cycle to the next Spark model",
    handler: async () => {
      const selection = await selector.cycle("next");
      if (selection) options.notify?.(formatSelection(selection), "info");
    },
  });

  keybindings.register({
    id: SPARK_MODEL_CYCLE_PREV_BINDING_ID,
    defaultKey: "shift+ctrl+p",
    description: "Cycle to the previous Spark model",
    handler: async () => {
      const selection = await selector.cycle("prev");
      if (selection) options.notify?.(formatSelection(selection), "info");
    },
  });
}

export function sparkModelSelectionValue(selection: SparkActiveSelection): string {
  return `${selection.providerName}/${selection.modelId}`;
}

export function sparkModelSelectionFromValue(value: string): SparkActiveSelection {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid Spark model selection value: ${value}`);
  }
  return { providerName: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function resolveSparkModelSelectionById(
  registry: SparkProviderRegistry,
  modelId: string,
): SparkActiveSelection {
  const trimmed = modelId.trim();
  if (!trimmed) throw new Error("Spark model id must be non-empty");
  if (trimmed.includes("/")) {
    const selection = sparkModelSelectionFromValue(trimmed);
    return {
      providerName: selection.providerName,
      modelId: resolveCanonicalModelId(registry, selection.providerName, selection.modelId),
    };
  }
  const matches = registry.listProviders().flatMap((provider) => {
    const model = provider.models.find((candidate) => modelIdMatches(candidate, trimmed));
    return model ? [{ providerName: provider.name, modelId: model.id }] : [];
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new Error(`Ambiguous Spark model id "${trimmed}"; use provider/model.`);
  throw new Error(`Unknown Spark model: ${trimmed}`);
}

export function formatSelection(selection: SparkActiveSelection): string {
  return `Model: ${sparkModelSelectionValue(selection)}`;
}

function resolveCanonicalModelId(
  registry: SparkProviderRegistry,
  providerName: string,
  modelId: string,
): string {
  const model = registry
    .listModelsFor(providerName)
    .find((candidate) => modelIdMatches(candidate, modelId));
  if (!model) throw new Error(`Provider "${providerName}" has no model with id "${modelId}"`);
  return model.id;
}

function modelIdMatches(model: ProviderModelDefinition, modelId: string): boolean {
  return model.id === modelId || (model.aliases ?? []).includes(modelId);
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

function selectionFromItem(item: SparkModelSelectorItem): SparkActiveSelection {
  return { providerName: item.providerName, modelId: item.modelId };
}

function describeModel(provider: ProviderConfig, model: ProviderModelDefinition): string {
  const route = model.transportApi ? `${provider.name} via ${model.transportApi}` : provider.name;
  const parts = [`route ${route}`, "health unknown"];
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
