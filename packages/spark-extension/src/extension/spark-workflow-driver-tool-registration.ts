import { Type } from "typebox";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import type { SparkWorkflowRunManagerController } from "./spark-workflow-run-manager.ts";

interface SparkWorkflowDriverToolDeps {
  workflowRunManager: Pick<SparkWorkflowRunManagerController, "runOnce">;
}

/** Internal adapter used only by daemon-owned workflow driver ticks. */
export function registerSparkWorkflowDriverTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkWorkflowDriverToolDeps,
): void {
  registerSparkTool({
    name: "workflow_driver",
    label: "Spark Workflow Driver",
    description:
      "Advance the active Spark workflow scheduler by one tick, then atomically schedule or stop the daemon-owned workflow driver.",
    parameters: Type.Object({
      action: Type.Literal("tick"),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: SparkToolContext) {
      if (!ctx.driver || ctx.driver.kind !== "workflow")
        return {
          content: [
            {
              type: "text" as const,
              text: "workflow_driver is available only in a daemon-owned workflow tick.",
            },
          ],
          details: { error: "workflow_driver_context_unavailable" },
          isError: true,
        };

      const result = await deps.workflowRunManager.runOnce(ctx.cwd, ctx);
      if (result.continuePolling) {
        await ctx.driver.schedule({
          delayMs: 1_000,
          reason: "workflow still has active or detached work",
        });
      } else {
        await ctx.driver.stop({ reason: "workflow reached a terminal or idle state" });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: result.continuePolling
              ? "Advanced the workflow and scheduled the next daemon tick."
              : "Advanced the workflow and stopped its daemon driver.",
          },
        ],
        details: { continuePolling: result.continuePolling },
      };
    },
  });
}
