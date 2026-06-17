import { type ProjectRef } from "@zendev-lab/pi-extension-api";
import { JsonStoreFormatError } from "./json-store.ts";

export type SparkRunStrategy = "sequential" | "parallel";
export type SparkPlanningModeSource = "auto" | "direct";
export type SparkAgentMode = "research" | "plan" | "implement";

export interface CurrentProjectStoreSnapshot {
  version: 1;
  projectRef?: ProjectRef;
}

export function normalizeCurrentProjectStoreSnapshot(
  raw: Record<string, unknown>,
  filePath: string,
): CurrentProjectStoreSnapshot {
  // Legacy current-project files may still carry mode/control blocks such as
  // planningMode, executionMode, or runMode. Spark mode is now per-turn derived,
  // and workflow run control lives in the workflow-run store, so tolerate-ignore
  // those legacy blocks and keep only the selected project pointer.
  if (raw.version !== undefined && raw.version !== 1) {
    throw new JsonStoreFormatError(filePath, "version must be 1");
  }
  const projectRef = requireString(raw.projectRef, filePath, "projectRef") as ProjectRef;
  return { version: 1, projectRef };
}

function requireString(value: unknown, filePath: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new JsonStoreFormatError(filePath, `${path} must be a non-empty string`);
  }
  return value;
}
