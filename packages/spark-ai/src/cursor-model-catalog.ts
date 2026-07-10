import type {
  ModelListItem,
  ModelParameterDefinition,
  ModelParameterValue,
  ModelSelection,
} from "@cursor/sdk";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

import type { ProviderModelDefinition } from "./provider-registry.ts";

const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface CursorModelMetadata {
  modelId: string;
  baseModelId: string;
  selectionModelId: string;
  defaultParams: ModelParameterValue[];
  contextWindow: number;
  supportsFast: boolean;
  fastOverride?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  parameterIds: {
    reasoning: boolean;
    effort: boolean;
    thinking: boolean;
    fast: boolean;
  };
}

const metadataByModelId = new Map<string, CursorModelMetadata>();

export function convertCursorModelItems(items: ModelListItem[]): ProviderModelDefinition[] {
  metadataByModelId.clear();
  const usedModelIds = new Set<string>();
  const reservedBaseIds = new Set(items.map((item) => item.id));
  const ambiguousAliases = findAmbiguousAliases(items);
  return [...items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((item) =>
      convertCursorModelItem(item, usedModelIds, reservedBaseIds, ambiguousAliases),
    );
}

export function getCursorModelMetadata(modelId: string): CursorModelMetadata | undefined {
  const metadata = metadataByModelId.get(modelId);
  return metadata ? cloneMetadata(metadata) : undefined;
}

export function getCursorModelMetadataEntries(): CursorModelMetadata[] {
  return [...metadataByModelId.values()].map(cloneMetadata);
}

export function buildCursorModelSelection(
  modelId: string,
  thinkingLevel: ModelThinkingLevel,
): ModelSelection {
  const metadata = metadataByModelId.get(modelId);
  if (!metadata) return { id: modelId };
  const params = cloneParams(metadata.defaultParams);
  applyThinkingLevel(metadata, params, thinkingLevel);
  return params.length > 0
    ? { id: metadata.selectionModelId, params }
    : { id: metadata.selectionModelId };
}

function convertCursorModelItem(
  item: ModelListItem,
  usedModelIds: Set<string>,
  reservedBaseIds: Set<string>,
  ambiguousAliases: Set<string>,
): ProviderModelDefinition[] {
  const defaultParams = getDefaultParams(item);
  const contextValues = getParameter(item, "context")?.values.map((value) => value.value) ?? [];
  const contexts: Array<string | undefined> =
    contextValues.length > 0 ? contextValues : [undefined];
  const supportsFast = getParameter(item, "fast") !== undefined;
  const fastOverrides: Array<boolean | undefined> = supportsFast
    ? [undefined, true, false]
    : [undefined];
  const definitions: ProviderModelDefinition[] = [];

  for (const selectionModelId of getSelectionModelIds(item, reservedBaseIds, ambiguousAliases)) {
    for (const context of contexts) {
      const contextParams = context
        ? replaceParam(defaultParams, "context", context)
        : cloneParams(defaultParams);
      for (const fastOverride of fastOverrides) {
        const params =
          fastOverride === undefined
            ? cloneParams(contextParams)
            : replaceParam(contextParams, "fast", fastOverride ? "true" : "false");
        const modelId = encodeCursorModelId(selectionModelId, context, fastOverride);
        if (usedModelIds.has(modelId)) continue;
        usedModelIds.add(modelId);

        const thinkingLevelMap = buildThinkingLevelMap(item);
        const metadata: CursorModelMetadata = {
          modelId,
          baseModelId: item.id,
          selectionModelId,
          defaultParams: params,
          contextWindow: parseContextWindow(context) ?? FALLBACK_CONTEXT_WINDOW,
          supportsFast,
          ...(fastOverride !== undefined ? { fastOverride } : {}),
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          parameterIds: {
            reasoning: getParameter(item, "reasoning") !== undefined,
            effort: getParameter(item, "effort") !== undefined,
            thinking: getParameter(item, "thinking") !== undefined,
            fast: supportsFast,
          },
        };
        metadataByModelId.set(modelId, metadata);
        definitions.push({
          id: modelId,
          name: displayName(item, selectionModelId, context, fastOverride),
          reasoning: thinkingLevelMap !== undefined,
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          input: ["text", "image"],
          cost: { ...ZERO_COST },
          contextWindow: metadata.contextWindow,
          maxTokens: FALLBACK_MAX_TOKENS,
        });
      }
    }
  }

  return definitions;
}

function getSelectionModelIds(
  item: ModelListItem,
  reservedBaseIds: Set<string>,
  ambiguousAliases: Set<string>,
): string[] {
  const ids = [item.id];
  for (const rawAlias of item.aliases ?? []) {
    const alias = rawAlias.trim();
    if (
      !alias ||
      alias === item.id ||
      ids.includes(alias) ||
      reservedBaseIds.has(alias) ||
      ambiguousAliases.has(alias)
    ) {
      continue;
    }
    ids.push(alias);
  }
  return ids;
}

function findAmbiguousAliases(items: ModelListItem[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const item of items) {
    for (const rawAlias of item.aliases ?? []) {
      const alias = rawAlias.trim();
      if (!alias || alias === item.id) continue;
      const ids = owners.get(alias) ?? new Set<string>();
      ids.add(item.id);
      owners.set(alias, ids);
    }
  }
  return new Set([...owners.entries()].filter(([, ids]) => ids.size > 1).map(([alias]) => alias));
}

function buildThinkingLevelMap(item: ModelListItem): ThinkingLevelMap | undefined {
  const reasoning = getParameter(item, "reasoning");
  const effort = getParameter(item, "effort");
  const thinking = getParameter(item, "thinking");
  const levelParameter = effort ?? reasoning ?? thinking;
  if (!levelParameter) return undefined;

  if (levelParameter.id === "thinking" && hasBooleanValues(levelParameter)) {
    return {
      off: parameterValue(levelParameter, "false"),
      minimal: null,
      low: null,
      medium: null,
      high: parameterValue(levelParameter, "true"),
      xhigh: null,
    };
  }

  return {
    off:
      parameterValue(reasoning, "none") ??
      parameterValue(reasoning, "off") ??
      parameterValue(thinking, "false"),
    minimal: comparableLevel(levelParameter, "minimal"),
    low: comparableLevel(levelParameter, "low"),
    medium: comparableLevel(levelParameter, "medium"),
    high: comparableLevel(levelParameter, "high"),
    xhigh: preferredParameterValue(levelParameter, ["xhigh", "max", "extra-high"]),
  };
}

function applyThinkingLevel(
  metadata: CursorModelMetadata,
  params: ModelParameterValue[],
  level: ModelThinkingLevel,
): void {
  const mapped = metadata.thinkingLevelMap?.[level];
  if (mapped === undefined || mapped === null) return;
  if (level === "off") {
    if (metadata.parameterIds.thinking && mapped === "false") {
      setParam(params, "thinking", mapped);
      deleteParam(params, "effort");
    } else if (metadata.parameterIds.reasoning) {
      setParam(params, "reasoning", mapped);
    }
    return;
  }
  if (metadata.parameterIds.effort) {
    if (metadata.parameterIds.thinking) setParam(params, "thinking", "true");
    setParam(params, "effort", mapped);
  } else if (metadata.parameterIds.reasoning) {
    setParam(params, "reasoning", mapped);
  } else if (metadata.parameterIds.thinking) {
    setParam(params, "thinking", mapped);
  }
}

function encodeCursorModelId(modelId: string, context?: string, fastOverride?: boolean): string {
  const qualified = context ? `${modelId}@${context}` : modelId;
  if (fastOverride === true) return `${qualified}:fast`;
  if (fastOverride === false) return `${qualified}:slow`;
  return qualified;
}

function displayName(
  item: ModelListItem,
  selectionModelId: string,
  context?: string,
  fastOverride?: boolean,
): string {
  const qualifiers: string[] = [];
  if (selectionModelId !== item.id) qualifiers.push(selectionModelId);
  if (fastOverride === true) qualifiers.push("fast");
  if (fastOverride === false) qualifiers.push("slow");
  const base = qualifiers.length
    ? `${item.displayName || item.id} (${qualifiers.join(", ")})`
    : item.displayName || item.id;
  return context ? `${base} @ ${context}` : base;
}

function parseContextWindow(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)([km])$/iu.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return Math.round(amount * (match[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000));
}

function getDefaultParams(item: ModelListItem): ModelParameterValue[] {
  const variant = item.variants?.find((candidate) => candidate.isDefault) ?? item.variants?.[0];
  return cloneParams(variant?.params ?? []);
}

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
  return item.parameters?.find((parameter) => parameter.id === id);
}

function parameterValue(
  parameter: ModelParameterDefinition | undefined,
  lowerValue: string,
): string | null {
  return (
    parameter?.values.find((candidate) => candidate.value.toLowerCase() === lowerValue)?.value ??
    null
  );
}

function preferredParameterValue(
  parameter: ModelParameterDefinition | undefined,
  lowerValues: string[],
): string | null {
  for (const value of lowerValues) {
    const result = parameterValue(parameter, value);
    if (result) return result;
  }
  return null;
}

function comparableLevel(
  parameter: ModelParameterDefinition | undefined,
  level: Exclude<ModelThinkingLevel, "off">,
): string | null {
  return level === "xhigh"
    ? preferredParameterValue(parameter, ["xhigh", "max", "extra-high"])
    : parameterValue(parameter, level);
}

function hasBooleanValues(parameter: ModelParameterDefinition): boolean {
  const values = new Set(parameter.values.map((value) => value.value.toLowerCase()));
  return values.has("false") && values.has("true");
}

function replaceParam(
  params: ModelParameterValue[],
  id: string,
  value: string,
): ModelParameterValue[] {
  const next = cloneParams(params);
  setParam(next, id, value);
  return next;
}

function setParam(params: ModelParameterValue[], id: string, value: string): void {
  const existing = params.find((parameter) => parameter.id === id);
  if (existing) existing.value = value;
  else params.push({ id, value });
}

function deleteParam(params: ModelParameterValue[], id: string): void {
  const index = params.findIndex((parameter) => parameter.id === id);
  if (index >= 0) params.splice(index, 1);
}

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
  return params.map((parameter) => ({ ...parameter }));
}

function cloneMetadata(metadata: CursorModelMetadata): CursorModelMetadata {
  return {
    ...metadata,
    defaultParams: cloneParams(metadata.defaultParams),
    ...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
    parameterIds: { ...metadata.parameterIds },
  };
}
