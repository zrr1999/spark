/**
 * @deprecated Project kind registry has been removed.
 * Project kinds are no longer a distinct concept; all projects are the same type.
 * The repro drive replaces the reproduction project kind's completion gate behavior.
 *
 * This file is kept as a thin stub to avoid breaking imports during migration.
 * Remove once all consumers are updated.
 */
import type { JsonValue, Project } from "@zendev-lab/spark-core";

// ---- Minimal retained types for backward-compat during migration ----

export type SparkProjectKindRender = "text" | "progress" | "counts" | "list";

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

// ---- Stubs that return neutral/no-op values ----

/** @deprecated Always returns the raw kind string or "generic". */
export function normalizeProjectKindId(value: unknown, _field = "kind"): string {
  if (value === undefined || value === null) return "generic";
  if (typeof value !== "string") return "generic";
  const trimmed = value.trim();
  return trimmed || "generic";
}

/** @deprecated Always returns a no-op display with no panels. */
export function renderSparkProjectKindDisplay(
  project: Pick<Project, "kind">,
): RenderedSparkProjectKindDisplay {
  const kind = normalizeProjectKindId(project.kind);
  return { kind, title: kind, panels: [] };
}

/** @deprecated No-op; never throws. */
export function requireKnownSparkProjectKind(_kind: unknown): void {
  // No-op: project kinds are no longer validated against a registry.
}

/** @deprecated Always returns undefined. */
export function sparkProjectKindRoleForPhase(
  _project: Pick<Project, "kind">,
  _phase: string,
): string | undefined {
  return undefined;
}

export interface SparkProjectKindCompletionGateResult {
  kind: string;
  gate: string;
  ok: boolean;
  summary: string;
  blockers: string[];
  details?: JsonValue;
}

/** @deprecated Always returns ok=true. Project kind completion gates are removed. */
export function evaluateSparkProjectKindCompletionGate(
  project: Pick<Project, "kind" | "kindState">,
): SparkProjectKindCompletionGateResult {
  return {
    kind: normalizeProjectKindId(project.kind),
    gate: "none",
    ok: true,
    summary: "project kind completion gates have been removed; use repro drive instead",
    blockers: [],
  };
}
