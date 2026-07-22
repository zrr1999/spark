import { Type } from "typebox";

import type { ModeRegistry } from "./registry.ts";
import type { Mode, ModeRenderContext } from "./types.ts";

/**
 * Canonical action-tool primitive for operating lenses. The tool is the
 * override/switch path (not a mandatory gate): the agent calls
 * `toolName({ action })` to change the current lens, and the tool returns the
 * new mode's requirements as its result.
 *
 * Spark native hosts register this as `phase` (see pi-extension
 * `registerSparkPhaseTool`); the library default remains `mode` for host-
 * neutral callers. Render as `phase action=<value>` / `mode action=<value>`.
 *
 * `action` is validated against the registered mode ids plus the reserved
 * `status` action.
 */
export const MODE_TOOL_STATUS_ACTION = "status" as const;

export interface CreateModeToolOptions {
  registry: ModeRegistry;
  /** Tool name, defaults to "mode". */
  name?: string;
  /** Tool label, defaults to "Mode". */
  label?: string;
}

export interface ModeToolDescriptor {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
}

function modeToolActions(registry: ModeRegistry): string[] {
  return [...registry.ids(), MODE_TOOL_STATUS_ACTION];
}

/** Build the static tool descriptor (name/label/description/parameters). */
export function createModeTool(options: CreateModeToolOptions): ModeToolDescriptor {
  const registry = options.registry;
  const actions = modeToolActions(registry);
  const name = options.name ?? "mode";
  const label = options.label ?? "Mode";
  const lensList = registry
    .list()
    .map((definition) => `${definition.id} (${definition.title})`)
    .join(", ");
  return {
    name,
    label,
    description: [
      `Switch the current per-turn operating lens. action one of: ${actions.join(" | ")}.`,
      `${MODE_TOOL_STATUS_ACTION} reports the current lens without changing it; any other action sets the lens for this turn and returns its requirements.`,
      `Registered lenses: ${lensList}.`,
    ].join(" "),
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: MODE_TOOL_STATUS_ACTION,
          description: `${actions.join(" | ")}. Defaults to ${MODE_TOOL_STATUS_ACTION}.`,
        }),
      ),
      focus: Type.Optional(
        Type.String({ description: "Optional focus to thread into the lens requirements." }),
      ),
    }),
  };
}

export type ModeToolAction = string;

/** Validate/normalize a raw `action` value against the registry + status. */
export function normalizeModeToolAction(value: unknown, registry: ModeRegistry): ModeToolAction {
  if (value === undefined || value === null) return MODE_TOOL_STATUS_ACTION;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`mode action must be one of: ${modeToolActions(registry).join(", ")}`);
  }
  const normalized = value.trim();
  if (normalized === MODE_TOOL_STATUS_ACTION) return MODE_TOOL_STATUS_ACTION;
  if (registry.has(normalized)) return normalized;
  throw new Error(`mode action must be one of: ${modeToolActions(registry).join(", ")}`);
}

export interface ModeToolResult {
  /** The resolved lens after applying the action. */
  mode: Mode;
  /** True when the action only reported status without switching. */
  statusOnly: boolean;
  /** The mode requirements text to return as the tool result. */
  text: string;
}

/**
 * Pure evaluation of a `mode` tool call: resolves the target lens and renders
 * its requirements. Hosts own side effects (e.g. recording the explicit
 * selection for this turn); this function never persists anything.
 */
export function runModeToolAction(input: {
  action: ModeToolAction;
  registry: ModeRegistry;
  currentMode: Mode;
  context: ModeRenderContext;
}): ModeToolResult {
  const statusOnly = input.action === MODE_TOOL_STATUS_ACTION;
  const targetMode = statusOnly ? input.currentMode : input.action;
  const definition = input.registry.require(targetMode);
  const requirements = definition.renderRequirements(input.context);
  const header = statusOnly
    ? `Current lens: ${definition.id} (${definition.title}).`
    : `Lens set to: ${definition.id} (${definition.title}) for this turn.`;
  return { mode: targetMode, statusOnly, text: `${header}\n\n${requirements}` };
}
