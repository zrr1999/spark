import { builtinRoleRef, type RoleRef } from "pi-roles";

export type SparkPresetKind = "function" | "workflow";

export interface SparkFunctionPreset {
  id: string;
  kind: SparkPresetKind;
  description: string;
  baseRoleRef: RoleRef;
  allowedTools: string[];
  runGuidance: string;
}

export const SPARK_PATCHER_PRESET_ID = "patcher";

export const SPARK_PATCHER_GRAFT_TOOLS = [
  "graft_help",
  "graft_init",
  "graft_status",
  "graft_ps",
  "graft_doctor",
  "graft_read",
  "graft_write",
  "graft_edit",
  "graft_delete",
  "graft_candidate_from_scratch",
  "graft_validate",
  "graft_admit",
  "graft_show",
  "graft_evidence",
  "graft_candidates",
  "graft_search",
  "graft_materialize",
  "graft_repo",
] as const;

export function createSparkFunctionPresets(): SparkFunctionPreset[] {
  return [
    {
      id: SPARK_PATCHER_PRESET_ID,
      kind: "function",
      description: "Produce a narrow patch through the Graft scratch/candidate workflow.",
      baseRoleRef: builtinRoleRef("worker"),
      allowedTools: [...SPARK_PATCHER_GRAFT_TOOLS],
      runGuidance: [
        "You are running Spark's patcher preset on top of the worker role.",
        "Use only the Graft scratch, candidate, validation, evidence, repository, and materialization tools made available by the preset.",
        "Do not edit the working tree directly; create and validate a Graft candidate, then report the candidate or admitted patch with evidence.",
      ].join("\n"),
    },
  ];
}
