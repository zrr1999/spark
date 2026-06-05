import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkMode,
  nextSparkSessionMode,
  saveSparkMode,
} from "./session-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkShortcutApi {
  registerShortcut?(
    shortcut: string,
    options: {
      description?: string;
      handler: (ctx: SparkToolContext) => unknown;
      isActive?: (ctx: SparkToolContext) => boolean;
    },
  ): void;
}

export function registerSparkModeCycleShortcut(
  pi: SparkShortcutApi,
  deps: { refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void> },
): void {
  pi.registerShortcut?.("shift+tab", {
    description: "Cycle Spark session mode (auto → research → plan → execute).",
    isActive: (ctx) => Boolean(ctx.cwd && existsSync(join(ctx.cwd, ".spark"))),
    async handler(ctx) {
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        ctx.ui?.notify?.("Spark mode cycle needs initialized Spark state.", "warning");
        return;
      }
      const current = await loadSparkMode(cwd, ctx);
      const next = nextSparkSessionMode(current.mode);
      if (next === "auto") {
        await saveSparkMode(cwd, ctx, { mode: "auto" });
        await deps.refreshSparkWidget(cwd, ctx);
        ctx.ui?.notify?.("Spark mode: auto", "info");
        return;
      }
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project) {
        ctx.ui?.notify?.("Spark mode cycle needs a current project.", "warning");
        return;
      }
      await saveSparkMode(cwd, ctx, {
        mode: next,
        projectRef: project.ref,
        executeStrategy: next === "execute" ? "default" : undefined,
        planningSource: next === "plan" ? "direct" : undefined,
      });
      await deps.refreshSparkWidget(cwd, ctx);
      ctx.ui?.notify?.(`Spark mode: ${next}`, "info");
    },
  });
}
