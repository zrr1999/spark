import type { ModeRegistry } from "./registry.ts";
import type { Mode, ModeRenderContext, TurnDriver } from "./types.ts";

/**
 * Render the compact standing mode marker line. This is the single short signal
 * naming the active lens + driver; the trivial `research`/`interactive`
 * combination renders nothing so plain turns stay noise-free.
 */
export function renderModeMarker(input: {
  mode: Mode;
  driver: TurnDriver;
  /** Toolset hint appended after the marker, if any. */
  toolsHint?: string;
}): string | undefined {
  const trivial = input.mode === "research" && input.driver === "interactive";
  const driverSuffix = input.driver === "interactive" ? "" : ` · ${input.driver}`;
  const marker = trivial ? "" : `Mode: ${input.mode}${driverSuffix}.`;
  const parts = [marker, input.toolsHint?.trim()].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

/**
 * Assemble the full per-turn system prompt: base prompt + marker + the active
 * mode's requirements + optional trailing context (e.g. a project/task summary
 * the host computed). Empty sections are dropped and sections are joined with a
 * blank line.
 */
export function assembleModeSystemPrompt(input: {
  basePrompt?: string;
  registry: ModeRegistry;
  mode: Mode;
  context: ModeRenderContext;
  marker?: string;
  trailingContext?: string;
}): string {
  const definition = input.registry.require(input.mode);
  const requirements = definition.renderRequirements(input.context);
  return [input.basePrompt, input.marker, requirements, input.trailingContext]
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
