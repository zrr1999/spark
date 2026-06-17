import type { ModeRegistry } from "./registry.ts";
import type { Mode, TurnDriver } from "./types.ts";

/**
 * Inputs for resolving the active per-turn mode.
 *
 * Precedence (highest first):
 * 1. `explicitSelection` — a slash command or `mode` tool call this turn.
 * 2. `suggest` — the driver/host's per-turn classification (e.g. a regex +
 *    project-state heuristic for the interactive driver, or a goal/workflow
 *    driver's own per-tick choice).
 * 3. `fallback` — the standing default lens (defaults to `"research"`).
 *
 * A selection or suggestion is only honored when it names a registered mode;
 * unknown ids fall through to the next source so a stale persisted/typo'd value
 * can never wedge the agent into an undefined lens.
 */
export interface ResolveActiveModeInput {
  registry: ModeRegistry;
  driver: TurnDriver;
  explicitSelection?: Mode;
  suggest?: Mode;
  fallback?: Mode;
}

export interface ResolvedActiveMode {
  mode: Mode;
  driver: TurnDriver;
  /** Which precedence source supplied the resolved mode. */
  source: "explicit" | "suggested" | "fallback";
}

export function resolveActiveMode(input: ResolveActiveModeInput): ResolvedActiveMode {
  const { registry, driver } = input;
  const fallback = input.fallback ?? "research";

  if (input.explicitSelection && registry.has(input.explicitSelection)) {
    return { mode: input.explicitSelection, driver, source: "explicit" };
  }
  if (input.suggest && registry.has(input.suggest)) {
    return { mode: input.suggest, driver, source: "suggested" };
  }
  if (registry.has(fallback)) {
    return { mode: fallback, driver, source: "fallback" };
  }
  const first = registry.ids()[0];
  if (!first) throw new Error("resolveActiveMode: mode registry is empty");
  return { mode: first, driver, source: "fallback" };
}

/**
 * Derive the active turn driver from concurrent foreground signals. Precedence:
 * active workflow run > active goal loop > interactive. This mirrors the
 * "foreground driver" axis; the background workflow slot is tracked separately
 * by the host and does not change the foreground mode.
 */
export function resolveTurnDriver(input: {
  workflowRunActive?: boolean;
  goalLoopActive?: boolean;
}): TurnDriver {
  if (input.workflowRunActive) return "workflow";
  if (input.goalLoopActive) return "goal";
  return "interactive";
}
