import vm from "node:vm";
import type { SparkWorkflowMeta } from "./types.ts";

export interface ParsedSparkWorkflowScript {
  meta: SparkWorkflowMeta;
  body: string;
}

export function parseSparkWorkflowScript(script: string): ParsedSparkWorkflowScript {
  const marker = "export const meta";
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0) throw new Error("Workflow script must export literal meta");
  const equalsIndex = script.indexOf("=", markerIndex + marker.length);
  if (equalsIndex < 0) throw new Error("Workflow script must assign literal meta");
  const objectStart = script.indexOf("{", equalsIndex);
  if (objectStart < 0) throw new Error("Workflow script meta must be an object literal");
  const objectEnd = findBalancedObjectEnd(script, objectStart);
  const meta = parseMetaLiteral(script.slice(objectStart, objectEnd + 1));
  let afterMeta = script.slice(objectEnd + 1).trimStart();
  if (afterMeta.startsWith(";")) afterMeta = afterMeta.slice(1).trimStart();
  return { meta, body: afterMeta };
}

function findBalancedObjectEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new Error("Workflow meta object is not balanced");
}

export function parseMetaLiteral(source: string): SparkWorkflowMeta {
  let value: unknown;
  try {
    value = new vm.Script("(" + source + " )").runInNewContext(Object.create(null), {
      timeout: 100,
    });
  } catch (error) {
    throw new Error(
      "Invalid workflow meta literal: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  return normalizeSparkWorkflowMeta(value);
}

export function normalizeSparkWorkflowMeta(value: unknown): SparkWorkflowMeta {
  if (!value || typeof value !== "object") throw new Error("workflow meta must be an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim())
    throw new Error("workflow meta.name must be a non-empty string");
  if (typeof raw.description !== "string" || !raw.description.trim())
    throw new Error("workflow meta.description must be a non-empty string");
  const meta: SparkWorkflowMeta = { name: raw.name.trim(), description: raw.description.trim() };
  if (typeof raw.whenToUse === "string" && raw.whenToUse.trim())
    meta.whenToUse = raw.whenToUse.trim();
  if (raw.phases !== undefined) {
    if (!Array.isArray(raw.phases)) throw new Error("workflow meta.phases must be an array");
    meta.phases = Array.from(raw.phases).map((phase, index) => {
      if (!phase || typeof phase !== "object")
        throw new Error("workflow meta.phases[" + index + "] must be an object");
      const candidate = phase as Record<string, unknown>;
      if (typeof candidate.title !== "string" || !candidate.title.trim())
        throw new Error("workflow meta.phases[" + index + "].title must be a non-empty string");
      return {
        title: candidate.title.trim(),
        ...(typeof candidate.detail === "string" && candidate.detail.trim()
          ? { detail: candidate.detail.trim() }
          : {}),
        ...(typeof candidate.model === "string" && candidate.model.trim()
          ? { model: candidate.model.trim() }
          : {}),
      };
    });
  }
  return meta;
}
