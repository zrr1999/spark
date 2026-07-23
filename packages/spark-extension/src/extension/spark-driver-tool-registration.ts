import { Type } from "typebox";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

/** Tick-local control surface. It is unavailable outside daemon-owned driver invocations. */
export function registerSparkDriverTool(registerSparkTool: SparkToolRegistrar): void {
  registerSparkTool({
    name: "driver",
    label: "Spark Driver",
    description:
      "Control the current daemon-owned autonomous driver tick. Actions: status, schedule, stop.",
    parameters: Type.Object({
      action: Type.String({ description: "status | schedule | stop" }),
      delayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 604_800_000 })),
      dueAt: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.driver) {
        return {
          content: [{ type: "text" as const, text: "No daemon driver tick is active." }],
          details: { error: "driver_context_unavailable" },
          isError: true,
        };
      }
      const action = params.action;
      if (action === "status") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Driver ${ctx.driver.driverId} generation ${ctx.driver.generation} is running.`,
            },
          ],
          details: {
            driverId: ctx.driver.driverId,
            generation: ctx.driver.generation,
            ownerSessionId: ctx.driver.ownerSessionId,
          },
        };
      }
      if (action === "stop") {
        const result = await ctx.driver.stop({
          reason: optionalString(params.reason) ?? "stopped by current tick",
        });
        return {
          content: [{ type: "text" as const, text: "Stopped the current Spark driver." }],
          details: { result },
        };
      }
      if (action === "schedule") {
        const result = await ctx.driver.schedule({
          ...(finiteNumber(params.delayMs) !== undefined
            ? { delayMs: finiteNumber(params.delayMs) }
            : {}),
          ...(optionalString(params.dueAt) ? { dueAt: optionalString(params.dueAt) } : {}),
          ...(optionalString(params.reason) ? { reason: optionalString(params.reason) } : {}),
        });
        return {
          content: [{ type: "text" as const, text: "Scheduled the next Spark driver tick." }],
          details: { result },
        };
      }
      throw new Error("driver action must be status, schedule, or stop");
    },
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
