import type { SparkDriveDerivationInput, SparkDriveDescriptor } from "./spark-drive-state.ts";

export const ASSIST_DRIVE_DESCRIPTOR = {
  id: "assist",
  label: "assist",
  priority: 0,
  aliases: ["interactive"],
  isActive: () => true,
} as const satisfies SparkDriveDescriptor;

export const LOOP_DRIVE_DESCRIPTOR = {
  id: "loop",
  label: "loop",
  priority: 40,
  isActive: (input: SparkDriveDerivationInput) => input.loop?.status === "active",
} as const satisfies SparkDriveDescriptor;

export const GOAL_DRIVE_DESCRIPTOR = {
  id: "goal",
  label: "goal",
  priority: 60,
  isActive: (input: SparkDriveDerivationInput) => input.goal?.status === "active",
} as const satisfies SparkDriveDescriptor;

export const REPRO_DRIVE_DESCRIPTOR = {
  id: "repro",
  label: "repro",
  priority: 80,
  isActive: (input: SparkDriveDerivationInput) => input.repro?.status === "active",
} as const satisfies SparkDriveDescriptor;

export const WORKFLOW_DRIVE_DESCRIPTOR = {
  id: "workflow",
  label: "workflow",
  priority: 100,
  isActive: (input: SparkDriveDerivationInput) => input.workflowActive === true,
} as const satisfies SparkDriveDescriptor;

export const DEFAULT_SPARK_DRIVE_DESCRIPTORS = [
  ASSIST_DRIVE_DESCRIPTOR,
  LOOP_DRIVE_DESCRIPTOR,
  GOAL_DRIVE_DESCRIPTOR,
  REPRO_DRIVE_DESCRIPTOR,
  WORKFLOW_DRIVE_DESCRIPTOR,
] as const satisfies readonly SparkDriveDescriptor[];
