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
import type { SparkLanguage } from "../spark-i18n.ts";
import { sparkSystemPromptLanguageDirective } from "../spark-i18n.ts";
import { loadSparkMode } from "../session-state.ts";
import type { SparkToolRegistrar } from "../spark-tool-registration.ts";

const SPARK_MODE_TOOLS_HINT =
  "Tools: task_read, task_write, assign, artifact, ask, role, learning, context, recall, workflow, pi-cue, pi-graft.";

let sparkModeRegistry: ModeRegistry | undefined;

export function createSparkModeRegistry(): ModeRegistry {
  return createModeRegistry({
    definitions: [
      sparkModeDefinition(
        "research",
        "Research",
        "investigate and answer without changing durable project state unless explicitly asked",
      ),
      sparkModeDefinition(
        "plan",
        "Plan",
        "clarify scope and create or revise concrete task plans when planning is requested",
      ),
      sparkModeDefinition(
        "implement",
        "Implement",
        "claim at most one concrete task, execute it, verify evidence, then stop or report blockers",
      ),
    ],
  });
}

export function defaultSparkModeRegistry(): ModeRegistry {
  sparkModeRegistry ??= createSparkModeRegistry();
  return sparkModeRegistry;
}

export function renderSparkModeSystemPrompt(input: {
  basePrompt?: string;
  mode?: Mode;
  driver?: TurnDriver;
  language?: SparkLanguage;
  trailingContext?: string;
}): string {
  const registry = defaultSparkModeRegistry();
  const driver = input.driver ?? "interactive";
  const resolved = registry.has(input.mode ?? "") ? input.mode! : "research";
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

export function registerSparkModeTool(registerSparkTool: SparkToolRegistrar): void {
  const registry = defaultSparkModeRegistry();
  const descriptor = createModeTool({ registry });
  registerSparkTool({
    ...descriptor,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeModeToolAction(params.action, registry);
      const current = await loadSparkMode(ctx.cwd, ctx);
      const result = runModeToolAction({
        action,
        registry,
        currentMode: current.mode,
        context: { driver: "interactive", focus: normalizeFocus(params.focus) },
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: { mode: result.mode, statusOnly: result.statusOnly },
      };
    },
  });
}

function sparkModeDefinition(id: Mode, title: string, summary: string) {
  return {
    id,
    title,
    summary,
    builtin: true,
    renderRequirements: () => `Spark mode: ${id}. ${SPARK_MODE_TOOLS_HINT}`,
  };
}

function normalizeFocus(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
