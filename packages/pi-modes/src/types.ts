/**
 * Core types for the per-turn operating mode (lens) mechanism.
 *
 * A **mode** is a per-turn operating lens. It is stateless and ephemeral: it
 * applies to the current agent turn, carries no durable content, and is
 * recomputed every turn. The registry is open, so hosts may register custom
 * modes beyond the built-in research/plan/implement subset.
 *
 * A **driver** is what propels the current turn. It derives the mode each turn
 * and owns any durable state in its own domain package (goal objective lives in
 * a goal package, workflow run state in a workflow package). `interactive` is
 * the first-class default and is never `undefined`.
 *
 * This package is pure mechanism: it never imports goal, workflow, or role
 * packages. Hosts wire those concepts in through the driver axis.
 */

/** A mode id. The registry is open, so this is a free string, not a union. */
export type Mode = string;

/** The built-in operating-lens subset that auto-classification may target. */
export const BUILTIN_MODES = ["research", "plan", "implement"] as const;
export type BuiltinMode = (typeof BUILTIN_MODES)[number];

/** What propels the current turn. `interactive` is the first-class default. */
export type TurnDriver = "interactive" | "goal" | "workflow";

export const TURN_DRIVERS: readonly TurnDriver[] = ["interactive", "goal", "workflow"] as const;

/**
 * Context passed to a mode definition when rendering its per-turn requirements.
 * `extra` is an open bag the host can use to thread through project/task state
 * without coupling this package to any concrete domain type.
 */
export interface ModeRenderContext {
  driver: TurnDriver;
  focus?: string;
  extra?: Record<string, unknown>;
}

/**
 * A registered operating lens. `renderRequirements` returns the full per-turn
 * system-prompt requirements for the mode. `builtin` marks the modes that
 * auto-classification is allowed to target; custom modes are reachable only via
 * explicit selection.
 */
export interface ModeDefinition {
  id: Mode;
  /** Human-facing label, e.g. "Research". */
  title: string;
  /** Optional one-line summary for menus/diagnostics. */
  summary?: string;
  /** True when the mode is part of the auto-classifiable built-in subset. */
  builtin?: boolean;
  renderRequirements: (context: ModeRenderContext) => string;
}
