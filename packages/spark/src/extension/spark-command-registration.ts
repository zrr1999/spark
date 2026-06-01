import { type SparkEntryIntent } from "./spark-entry.ts";
import {
  applySparkEntryResolution,
  type SparkEntryApplicationDeps,
} from "./spark-entry-application.ts";
import { detectSparkProjectState, resolveSparkEntry } from "./spark-entry-resolution.ts";
import { loadSparkGraph } from "./session-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkCommandContext extends SparkToolContext {
  waitForIdle?: () => Promise<void>;
  setEditorText?: (text: string) => void;
}

export interface SparkCommandApi {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: SparkCommandContext) => void | Promise<void>;
    },
  ): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
}

interface SparkCommandRegistrationDeps extends SparkEntryApplicationDeps {}

export function registerSparkCommands(
  pi: SparkCommandApi,
  deps: SparkCommandRegistrationDeps,
): void {
  pi.registerCommand("spark", {
    description:
      "Enter the inferred Spark mode, or initialize a new Spark idea with /spark <idea>.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, { kind: "auto", prompt: args.trim() });
    },
  });

  pi.registerCommand("plan", {
    description:
      "Enter Spark planning mode directly, or initialize an existing non-empty project into planning mode.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "planning",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("execute", {
    description: "Enter Spark execution mode directly to execute one task, then stop.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "execution",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("run", {
    description:
      "Start Spark sequential run mode (foreground loop); use /run-parallel for background parallel execution.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "run",
        prompt: args.trim(),
        runStrategy: "sequential",
      });
    },
  });

  pi.registerCommand("run-sequential", {
    description:
      "Start Spark run mode to continuously execute ready tasks one at a time until done or blocked.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "run",
        prompt: args.trim(),
        runStrategy: "sequential",
      });
    },
  });

  pi.registerCommand("run-parallel", {
    description:
      "Start Spark run mode to continuously execute ready tasks in parallel until done or blocked.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "run",
        prompt: args.trim(),
        runStrategy: "parallel",
      });
    },
  });

  async function handleSparkEntryCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    intent: SparkEntryIntent,
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const projectState = await detectSparkProjectState(ctx.cwd, graph, ctx);
    const resolution = await resolveSparkEntry(ctx, intent, graph, projectState);
    await applySparkEntryResolution(piApi, deps, ctx, graph, resolution);
  }
}
