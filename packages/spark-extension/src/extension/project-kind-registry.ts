import type { JsonValue, Project } from "@zendev-lab/pi-extension-api";
import type { SparkSessionPhase } from "./session-state.ts";

export const GENERIC_SPARK_PROJECT_KIND = "generic";
export const REPRODUCTION_SPARK_PROJECT_KIND = "reproduction";

export type SparkProjectKindRender = "text" | "progress" | "counts" | "list";

export interface SparkProjectKindDisplayPanel {
  label: string;
  source: string;
  render: SparkProjectKindRender;
}

export interface SparkProjectKindDisplay {
  badge?: string;
  panels: SparkProjectKindDisplayPanel[];
}

export interface SparkProjectKindDefinition {
  id: string;
  title: string;
  completionGate: string;
  phasePlan: Partial<Record<SparkSessionPhase, string>>;
  stateSchema?: string;
  display: SparkProjectKindDisplay;
}

export interface RenderedSparkProjectKindPanel {
  label: string;
  source: string;
  render: SparkProjectKindRender;
  text: string;
  value?: JsonValue;
}

export interface RenderedSparkProjectKindDisplay {
  kind: string;
  title: string;
  badge?: string;
  panels: RenderedSparkProjectKindPanel[];
}

export type SparkProjectKindRegistry = ReadonlyMap<string, SparkProjectKindDefinition>;

export const GENERIC_SPARK_PROJECT_KIND_DEFINITION: SparkProjectKindDefinition = {
  id: GENERIC_SPARK_PROJECT_KIND,
  title: "Generic",
  completionGate: "task_graph",
  phasePlan: {},
  display: { panels: [] },
};

export const REPRODUCTION_SPARK_PROJECT_KIND_DEFINITION: SparkProjectKindDefinition = {
  id: REPRODUCTION_SPARK_PROJECT_KIND,
  title: "Reproduction",
  completionGate:
    "successMetrics_all_covered_and_failed_experiments_dispositioned_and_learning_recorded",
  phasePlan: { research: "researcher", plan: "planner", implement: "engineer" },
  stateSchema:
    "reproduction-v1: target{sourceRefs,targetEnv,expectedOutputs,successMetrics[]} + experiments[] + findings[] + learningRefs[]",
  display: {
    badge: "repro",
    panels: [
      { label: "Target", source: "kindState.target", render: "text" },
      { label: "Metrics", source: "kindState.target.successMetrics", render: "progress" },
      { label: "Experiments", source: "kindState.experiments", render: "counts" },
      { label: "Findings", source: "kindState.findings", render: "list" },
    ],
  },
};

export const BUILTIN_SPARK_PROJECT_KIND_DEFINITIONS: readonly SparkProjectKindDefinition[] = [
  GENERIC_SPARK_PROJECT_KIND_DEFINITION,
  REPRODUCTION_SPARK_PROJECT_KIND_DEFINITION,
];

let defaultRegistry: SparkProjectKindRegistry | undefined;

export function createSparkProjectKindRegistry(
  definitions: readonly SparkProjectKindDefinition[] = BUILTIN_SPARK_PROJECT_KIND_DEFINITIONS,
): SparkProjectKindRegistry {
  const entries = definitions.map((definition) => {
    const id = normalizeProjectKindId(definition.id, "project kind id");
    return [id, { ...definition, id }] as const;
  });
  return new Map(entries);
}

export function defaultSparkProjectKindRegistry(): SparkProjectKindRegistry {
  defaultRegistry ??= createSparkProjectKindRegistry();
  return defaultRegistry;
}

export function normalizeProjectKindId(value: unknown, field = "kind"): string {
  if (value === undefined || value === null) return GENERIC_SPARK_PROJECT_KIND;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return GENERIC_SPARK_PROJECT_KIND;
  return trimmed;
}

export function requireKnownSparkProjectKind(
  kind: unknown,
  registry: SparkProjectKindRegistry = defaultSparkProjectKindRegistry(),
): SparkProjectKindDefinition {
  const id = normalizeProjectKindId(kind);
  const definition = registry.get(id);
  if (!definition) {
    throw new Error(
      `unknown project kind: ${id}. Known kinds: ${[...registry.keys()].sort().join(", ")}`,
    );
  }
  return definition;
}

export function sparkProjectKindId(project: Pick<Project, "kind">): string {
  return normalizeProjectKindId(project.kind);
}

export function sparkProjectKindDefinitionForProject(
  project: Pick<Project, "kind">,
  registry: SparkProjectKindRegistry = defaultSparkProjectKindRegistry(),
): SparkProjectKindDefinition | undefined {
  return registry.get(sparkProjectKindId(project));
}

export function sparkProjectKindRoleForPhase(
  project: Pick<Project, "kind">,
  phase: SparkSessionPhase,
  registry: SparkProjectKindRegistry = defaultSparkProjectKindRegistry(),
): string | undefined {
  return sparkProjectKindDefinitionForProject(project, registry)?.phasePlan[phase];
}

export interface SparkProjectKindCompletionGateResult {
  kind: string;
  gate: string;
  ok: boolean;
  summary: string;
  blockers: string[];
  details?: JsonValue;
}

export function evaluateSparkProjectKindCompletionGate(
  project: Project,
  registry: SparkProjectKindRegistry = defaultSparkProjectKindRegistry(),
): SparkProjectKindCompletionGateResult {
  const definition = sparkProjectKindDefinitionForProject(project, registry);
  if (!definition || definition.id === GENERIC_SPARK_PROJECT_KIND) {
    return {
      kind: sparkProjectKindId(project),
      gate: definition?.completionGate ?? "unknown",
      ok: true,
      summary: "generic project kind delegates completion to the task graph",
      blockers: [],
    };
  }
  if (definition.id === REPRODUCTION_SPARK_PROJECT_KIND)
    return evaluateReproductionCompletionGate(project, definition);
  return {
    kind: definition.id,
    gate: definition.completionGate,
    ok: true,
    summary: `${definition.id} project kind has no deterministic completion gate evaluator`,
    blockers: [],
  };
}

export function renderSparkProjectKindDisplay(
  project: Project,
  registry: SparkProjectKindRegistry = defaultSparkProjectKindRegistry(),
): RenderedSparkProjectKindDisplay {
  const kind = sparkProjectKindId(project);
  const definition =
    registry.get(kind) ??
    ({
      id: kind,
      title: kind,
      completionGate: "unknown",
      phasePlan: {},
      display: { badge: kind, panels: [] },
    } satisfies SparkProjectKindDefinition);
  const panels = definition.display.panels.flatMap((panel) => {
    const value = resolveProjectKindSource(project, panel.source);
    const text = renderProjectKindPanelValue(panel.render, value);
    return text ? [{ ...panel, text, ...(isJsonValue(value) ? { value } : {}) }] : [];
  });
  return {
    kind,
    title: definition.title,
    ...(definition.display.badge ? { badge: definition.display.badge } : {}),
    panels,
  };
}

function resolveProjectKindSource(project: Project, source: string): unknown {
  const parts = source
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let value: unknown = project;
  for (const part of parts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function renderProjectKindPanelValue(render: SparkProjectKindRender, value: unknown): string {
  if (value === undefined || value === null) return "";
  switch (render) {
    case "text":
      return renderTextValue(value);
    case "progress":
      return renderProgressValue(value);
    case "counts":
      return renderCountsValue(value);
    case "list":
      return renderListValue(value);
  }
}

function renderTextValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderProgressValue(value: unknown): string {
  if (isRecord(value)) {
    const done = numberField(value, "done") ?? numberField(value, "completed") ?? 0;
    const total = numberField(value, "total") ?? numberField(value, "count") ?? 0;
    if (total > 0) return `${done}/${total}`;
  }
  if (Array.isArray(value)) {
    const total = value.length;
    const done = value.filter((item) => {
      if (!isRecord(item)) return false;
      if (item.covered === true) return true;
      const status = typeof item.status === "string" ? item.status.toLocaleLowerCase() : "";
      return ["done", "covered", "passed", "success", "satisfied"].includes(status);
    }).length;
    return total > 0 ? `${done}/${total}` : "0/0";
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return renderTextValue(value);
}

function renderCountsValue(value: unknown): string {
  if (Array.isArray(value)) return String(value.length);
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => typeof entry === "number" || Array.isArray(entry))
      .map(([key, entry]) => `${key}=${Array.isArray(entry) ? entry.length : String(entry)}`);
    return entries.join(" ");
  }
  return renderTextValue(value);
}

function renderListValue(value: unknown): string {
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (isRecord(item)) {
        const title = item.title ?? item.name ?? item.id;
        return typeof title === "string" ? title.trim() : JSON.stringify(item);
      }
      return renderTextValue(item);
    })
    .filter(Boolean)
    .slice(0, 5)
    .join(", ");
}

function evaluateReproductionCompletionGate(
  project: Project,
  definition: SparkProjectKindDefinition,
): SparkProjectKindCompletionGateResult {
  const state = isRecord(project.kindState) ? project.kindState : undefined;
  const target = state && isRecord(state.target) ? state.target : undefined;
  const successMetrics = arrayField(target, "successMetrics");
  const experiments = arrayField(state, "experiments");
  const findings = arrayField(state, "findings");
  const learningRefs = arrayField(state, "learningRefs");
  const blockers: string[] = [];

  if (!target) blockers.push("reproduction_target_missing");
  if (successMetrics.length === 0) blockers.push("reproduction_success_metrics_missing");
  const metricCoverage = successMetrics.map((metric, index) => ({
    label: reproductionMetricLabel(metric, index),
    covered: reproductionMetricCovered(metric, findings),
  }));
  const uncoveredMetrics = metricCoverage.filter((metric) => !metric.covered);
  if (uncoveredMetrics.length > 0)
    blockers.push(
      `reproduction_success_metrics_uncovered=${uncoveredMetrics
        .map((metric) => metric.label)
        .join(",")}`,
    );

  const failedWithoutDisposition = experiments
    .filter(reproductionExperimentFailed)
    .filter((experiment) => !reproductionHasDisposition(experiment));
  if (failedWithoutDisposition.length > 0)
    blockers.push(
      `reproduction_failed_experiments_without_disposition=${failedWithoutDisposition.length}`,
    );

  const learningRecorded =
    learningRefs.length > 0 || findings.some((finding) => reproductionHasLearningRef(finding));
  if (!learningRecorded) blockers.push("reproduction_learning_not_recorded");

  const details = {
    metrics: {
      done: metricCoverage.length - uncoveredMetrics.length,
      total: metricCoverage.length,
    },
    experiments: {
      total: experiments.length,
      failedWithoutDisposition: failedWithoutDisposition.length,
    },
    findings: findings.length,
    learningRecorded,
  } satisfies JsonValue;
  return {
    kind: definition.id,
    gate: definition.completionGate,
    ok: blockers.length === 0,
    summary:
      blockers.length === 0
        ? "reproduction gate satisfied: success metrics covered, failures dispositioned, learning recorded"
        : `reproduction gate blocked: ${blockers.join("; ")}`,
    blockers,
    details,
  };
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function reproductionMetricLabel(metric: unknown, index: number): string {
  if (typeof metric === "string" && metric.trim()) return compactGateLabel(metric);
  if (isRecord(metric)) {
    const id =
      stringField(metric, "id") ?? stringField(metric, "name") ?? stringField(metric, "title");
    if (id) return compactGateLabel(id);
  }
  return `metric-${index + 1}`;
}

function reproductionMetricCovered(metric: unknown, findings: unknown[]): boolean {
  if (isRecord(metric)) {
    if (metric.covered === true) return true;
    const status = stringField(metric, "status")?.toLocaleLowerCase();
    if (status && ["covered", "done", "passed", "success", "satisfied"].includes(status))
      return true;
  }
  const label = reproductionMetricLabel(metric, 0).toLocaleLowerCase();
  return findings.some((finding) => reproductionFindingCoversMetric(finding, label));
}

function reproductionFindingCoversMetric(finding: unknown, label: string): boolean {
  if (!isRecord(finding)) return false;
  if (finding.covered === true && label === "metric-1") return true;
  const fields = [
    stringField(finding, "metric"),
    stringField(finding, "metricId"),
    stringField(finding, "successMetric"),
    stringField(finding, "title"),
    stringField(finding, "summary"),
  ]
    .filter((field): field is string => Boolean(field))
    .map((field) => field.toLocaleLowerCase());
  return fields.some((field) => field.includes(label) || label.includes(field));
}

function reproductionExperimentFailed(experiment: unknown): boolean {
  if (!isRecord(experiment)) return false;
  const status = stringField(experiment, "status")?.toLocaleLowerCase();
  return Boolean(status && ["fail", "failed", "error", "regression", "blocked"].includes(status));
}

function reproductionHasDisposition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const disposition = value.disposition;
  if (typeof disposition === "string") return disposition.trim().length > 0;
  if (isRecord(disposition)) return Object.keys(disposition).length > 0;
  return false;
}

function reproductionHasLearningRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const ref = stringField(value, "learningRef") ?? stringField(value, "learningArtifactRef");
  return Boolean(ref);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function compactGateLabel(value: string): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
