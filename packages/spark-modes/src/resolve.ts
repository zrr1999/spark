import type { ModeRegistry } from "./registry.ts";
import type { Mode, TurnDriver } from "./types.ts";

/**
 * Inputs for resolving the active per-turn mode.
 *
 * Precedence (highest first):
 * 1. `explicitSelection` — a slash command or `mode` tool call this turn.
 * 2. `suggest` — the drive/host's per-turn classification (e.g. a regex +
 *    project-state heuristic for the assist drive, or a goal/loop/workflow
 *    drive's own per-tick choice).
 * 3. `fallback` — the standing default lens (defaults to `"plan"`).
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
  const fallback = input.fallback ?? "plan";

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
 * active workflow run > active goal > active loop > assist. This mirrors the
 * foreground drive axis; background workflow slots are tracked separately by the
 * host and do not change the foreground mode.
 */
export function resolveTurnDriver(input: {
  workflowRunActive?: boolean;
  goalActive?: boolean;
  /** @deprecated Use goalActive. */
  goalLoopActive?: boolean;
  loopActive?: boolean;
}): TurnDriver {
  if (input.workflowRunActive) return "workflow";
  if (input.goalActive ?? input.goalLoopActive) return "goal";
  if (input.loopActive) return "loop";
  return "assist";
}
