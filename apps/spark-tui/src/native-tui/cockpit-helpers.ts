/** Cockpit panel helpers shared by the native TUI app. */

import type { SparkArtifactView, SparkRunView } from "@zendev-lab/spark-protocol";

import { stringFromRecord } from "./message-view.ts";
import {
  SPARK_COCKPIT_PANELS,
  SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
  type SparkNativeCockpitPanel,
  type SparkNativeCockpitState,
  type SparkNativeSlashCommand,
} from "./types.ts";

export function isSparkNativeCockpitPanel(value: string): value is SparkNativeCockpitPanel {
  return (SPARK_COCKPIT_PANELS as readonly string[]).includes(value);
}

export function isSparkNativeLocalControlCommand(command: SparkNativeSlashCommand): boolean {
  return command.metadata?.extensionId === SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID;
}

export function createSparkNativeCockpitState(): SparkNativeCockpitState {
  return {
    workflows: new Map(),
    runs: new Map(),
    tasks: new Map(),
    artifacts: new Map(),
    evidence: new Map(),
    interactions: new Map(),
  };
}

export function isDoneTaskStatus(status: string): boolean {
  return ["done", "completed", "succeeded", "success"].includes(status.toLowerCase());
}

export function cockpitTaskDeepLink(taskRef: string): string {
  return `cockpit://tasks/${encodeURIComponent(taskRef)}`;
}

export function isReviewArtifact(
  artifact: Pick<SparkArtifactView, "title" | "preview" | "producer" | "metadata">,
): boolean {
  return (
    artifact.producer === "review" ||
    stringFromRecord(artifact.metadata, "producer") === "review" ||
    Boolean(
      stringFromRecord(artifact.metadata, "reviewer") ??
      stringFromRecord(artifact.metadata, "verdict") ??
      stringFromRecord(artifact.metadata, "outcome"),
    ) ||
    /\breview(er)?\b|verdict/iu.test(`${artifact.title} ${artifact.preview ?? ""}`)
  );
}

export function graftSummaryFromRecord(record: Record<string, unknown>): string | undefined {
  const patch = stringFromRecord(record, "patchRef") ?? stringFromRecord(record, "patch");
  const candidate =
    stringFromRecord(record, "candidateRef") ?? stringFromRecord(record, "candidate");
  const base = stringFromRecord(record, "base") ?? stringFromRecord(record, "baseRef");
  const status = stringFromRecord(record, "graftStatus") ?? stringFromRecord(record, "status");
  if (!patch && !candidate && !base && !status) return undefined;
  return [
    patch ? `patch=${patch}` : undefined,
    candidate ? `candidate=${candidate}` : undefined,
    base ? `base=${base}` : undefined,
    status ? `status=${status}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function workflowRunDisplayStatus(run: SparkRunView): string {
  return stringFromRecord(run.metadata, "dynamicStatus") ?? run.status;
}

export function workflowRunControlHints(run: SparkRunView): string[] {
  if (!/^run:[a-zA-Z0-9-]+$/u.test(run.id)) {
    return ["Actions: /workflow-runs to open the live dynamic workflow dashboard"];
  }
  const inspect = `/workflow-inspect ${run.id}`;
  const save = `/workflow-save ${run.id}`;
  const status = workflowRunDisplayStatus(run);
  if (status === "running" || status === "queued") {
    return [
      `Actions: ${inspect}`,
      `         /workflow-pause ${run.id}`,
      `         /workflow-stop ${run.id}`,
      `         ${save}`,
    ];
  }
  if (status === "paused" || status === "stale") {
    return [
      `Actions: ${inspect}`,
      `         /workflow-resume ${run.id}`,
      `         /workflow-stop ${run.id}`,
      `         /workflow-restart ${run.id}`,
      `         ${save}`,
      `         /workflow-ack ${run.id}`,
    ];
  }
  return [
    `Actions: ${inspect}`,
    `         /workflow-restart ${run.id}`,
    `         ${save}`,
    `         /workflow-ack ${run.id}`,
  ];
}

export function compareRunsForCockpit(left: SparkRunView, right: SparkRunView): number {
  const rank = (run: SparkRunView): number => {
    if (run.kind === "role") return 0;
    if (run.kind === "workflow") return 1;
    if (run.kind === "task") return 2;
    return 3;
  };
  return rank(left) - rank(right) || left.id.localeCompare(right.id);
}
