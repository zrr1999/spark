import { existsSync } from "node:fs";
import { join } from "node:path";

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
  _deps: { refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void> },
): void {
  pi.registerShortcut?.("shift+tab", {
    description: "Show Spark per-turn mode slash command hints.",
    isActive: (ctx) => Boolean(ctx.cwd && existsSync(join(ctx.cwd, ".spark"))),
    handler(ctx) {
      const hint =
        "/research, /plan, and /implement are per-turn Spark lenses; they no longer persist session mode.";
      ctx.ui?.setEditorText?.("/plan ");
      ctx.ui?.notify?.(`Spark mode lenses are per-turn. Use ${hint}`, "info");
    },
  });
}
