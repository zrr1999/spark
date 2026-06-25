import {
  assembleModeSystemPrompt,
  createModeRegistry,
  createModeTool,
  normalizeModeToolAction,
  runModeToolAction,
  type Mode,
  type ModeRegistry,
  type TurnDriver,
} from "@zendev-lab/pi-modes";
import { sparkActiveLens } from "../spark-drive-state.ts";
import type { SparkLanguage } from "../spark-i18n.ts";
import { sparkSystemPromptLanguageDirective } from "../spark-i18n.ts";
import { loadSparkPhase, saveSparkPhase } from "../session-state.ts";
import type { SparkToolRegistrar } from "../spark-tool-registration.ts";

const SPARK_PHASE_TOOLS_HINT =
  "Tools: task_read, task_write, assign, artifact, ask, role, learning, context, recall, workflow, pi-cue, pi-graft.";

let sparkPhaseRegistry: ModeRegistry | undefined;

export function createSparkPhaseRegistry(): ModeRegistry {
  return createModeRegistry({
    definitions: [
      sparkPhaseDefinition(
        "research",
        "Default research",
        "default lightweight investigation and answering without changing durable project state unless explicitly asked",
      ),
      sparkPhaseDefinition(
        "plan",
        "Plan",
        "clarify scope and create or revise concrete task plans when planning is requested",
      ),
      sparkPhaseDefinition(
        "implement",
        "Implement",
        "claim and finish one concrete task at a time, continuing until blocked",
      ),
    ],
  });
}

export function defaultSparkPhaseRegistry(): ModeRegistry {
  sparkPhaseRegistry ??= createSparkPhaseRegistry();
  return sparkPhaseRegistry;
}

export function renderSparkPhaseSystemPrompt(input: {
  basePrompt?: string;
  phase?: Mode;
  driver?: TurnDriver;
  language?: SparkLanguage;
  trailingContext?: string;
}): string {
  const registry = defaultSparkPhaseRegistry();
  const driver = input.driver ?? "assist";
  const resolved = registry.has(input.phase ?? "") ? input.phase! : "research";
  const languageDirective = input.language
    ? sparkSystemPromptLanguageDirective(input.language)
    : undefined;
  return assembleModeSystemPrompt({
    basePrompt: input.basePrompt,
    registry,
    mode: resolved,
    context: { driver },
    trailingContext: [languageDirective, input.trailingContext]
      .map((section) => section?.trim())
      .filter((section): section is string => Boolean(section))
      .join("\n\n"),
  });
}

/** @deprecated Use createSparkPhaseRegistry. */
export const createSparkModeRegistry = createSparkPhaseRegistry;
/** @deprecated Use defaultSparkPhaseRegistry. */
export const defaultSparkModeRegistry = defaultSparkPhaseRegistry;
/** @deprecated Use renderSparkPhaseSystemPrompt. */
export function renderSparkModeSystemPrompt(input: {
  basePrompt?: string;
  mode?: Mode;
  phase?: Mode;
  driver?: TurnDriver;
  language?: SparkLanguage;
  trailingContext?: string;
}): string {
  return renderSparkPhaseSystemPrompt({ ...input, phase: input.phase ?? input.mode });
}

export function registerSparkPhaseTool(registerSparkTool: SparkToolRegistrar): void {
  const registry = defaultSparkPhaseRegistry();
  const descriptor = createModeTool({ registry, name: "phase", label: "Phase" });
  registerSparkTool({
    ...descriptor,
    description: [
      "Switch the current session operating phase.",
      "action=status reports the current phase without changing it; research, plan, or implement sets the persisted session phase and returns its requirements.",
      "Registered phases: research, plan, implement.",
    ].join(" "),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeModeToolAction(params.action, registry);
      const current = await loadSparkPhase(ctx.cwd, ctx);
      const result = runModeToolAction({
        action,
        registry,
        currentMode: current.phase,
        context: { driver: "assist", focus: normalizeFocus(params.focus) },
      });
      if (!result.statusOnly) {
        const phase = result.mode as "research" | "plan" | "implement";
        await saveSparkPhase(ctx.cwd, ctx, { phase, projectRef: current.projectRef });
        ctx.sparkActiveLens = sparkActiveLens(phase, "assist");
      }
      const text = result.text
        .replace(/^Current lens:/u, "Current phase:")
        .replace(/^Lens set to:/u, "Phase set to:")
        .replace(/ for this turn\./u, ".");
      return {
        content: [{ type: "text", text }],
        details: { phase: result.mode, statusOnly: result.statusOnly },
      };
    },
  });
}

/** @deprecated Use registerSparkPhaseTool. */
export const registerSparkModeTool = registerSparkPhaseTool;

function sparkPhaseDefinition(id: Mode, title: string, summary: string) {
  return {
    id,
    title,
    summary,
    builtin: true,
    renderRequirements: () =>
      id === "research"
        ? `Spark default research phase. ${SPARK_PHASE_TOOLS_HINT}`
        : `Spark phase: ${id}. ${SPARK_PHASE_TOOLS_HINT}`,
  };
}

function normalizeFocus(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
