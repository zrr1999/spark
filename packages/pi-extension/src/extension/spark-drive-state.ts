import type { SparkSessionGoal } from "./spark-session-goals.ts";
import type { SparkSessionLoop } from "./spark-session-loops.ts";

export const SPARK_DRIVE_MODES = ["assist", "loop", "goal", "workflow"] as const;
export type SparkDriveMode = (typeof SPARK_DRIVE_MODES)[number];

/** @deprecated Old name for the default assist drive. */
export type SparkLegacyDriveMode = "interactive";
export type SparkDriveModeInput = SparkDriveMode | SparkLegacyDriveMode;

export interface SparkActiveLensDriveState {
  phase?: "research" | "plan" | "implement";
  /** Read-only derived drive mode. */
  mode?: SparkDriveMode | "research" | "plan" | "implement";
  /** Canonical drive value for new callers. */
  drive?: SparkDriveModeInput;
  /** @deprecated Use drive/mode. */
  driver?: SparkDriveModeInput;
}

export function normalizeSparkDriveMode(value: unknown): SparkDriveMode | undefined {
  if (value === "interactive") return "assist";
  if (value === "assist" || value === "loop" || value === "goal" || value === "workflow")
    return value;
  return undefined;
}

export function sparkActiveLensDriveMode(
  lens: SparkActiveLensDriveState | undefined,
): SparkDriveMode {
  return (
    normalizeSparkDriveMode(lens?.drive) ??
    normalizeSparkDriveMode(lens?.mode) ??
    normalizeSparkDriveMode(lens?.driver) ??
    "assist"
  );
}

export function sparkActiveLensPhase(
  lens: SparkActiveLensDriveState | undefined,
): "research" | "plan" | "implement" {
  if (lens?.phase === "research" || lens?.phase === "plan" || lens?.phase === "implement")
    return lens.phase;
  // Legacy active-lens mode used to mean phase. Accept it only when it is a phase value.
  if (lens?.mode === "research" || lens?.mode === "plan" || lens?.mode === "implement")
    return lens.mode;
  return "research";
}

export function sparkActiveLens(
  phase: "research" | "plan" | "implement",
  drive: SparkDriveModeInput = "assist",
): {
  phase: "research" | "plan" | "implement";
  mode: SparkDriveMode;
  drive: SparkDriveMode;
} {
  const normalized = normalizeSparkDriveMode(drive) ?? "assist";
  return { phase, mode: normalized, drive: normalized };
}

export function deriveSparkDriveMode(input: {
  activeLens?: SparkActiveLensDriveState;
  workflowActive?: boolean;
  goal?: SparkSessionGoal | null | undefined;
  loop?: SparkSessionLoop | null | undefined;
}): SparkDriveMode {
  const explicit = sparkActiveLensDriveMode(input.activeLens);
  if (explicit !== "assist") return explicit;
  if (input.workflowActive) return "workflow";
  if (input.goal?.status === "active") return "goal";
  if (input.loop?.status === "active") return "loop";
  return "assist";
}

export function renderSparkDriveMode(mode: SparkDriveMode): string {
  switch (mode) {
    case "assist":
      return "assist";
    case "loop":
      return "loop";
    case "goal":
      return "goal";
    case "workflow":
      return "workflow";
  }
}
