import { compactLoopPrompt } from "./prompts.ts";
import type { LoopPolicy, LoopTickInput, LoopTickResult } from "./types.ts";
import { recordLoopTick, unixSeconds } from "./state.ts";

export function evaluateLoopTick(input: LoopTickInput, policy: LoopPolicy = {}): LoopTickResult {
  const now = input.now ?? unixSeconds();
  const loop = input.loop;
  if (!loop) return { decision: "paused", loop: null, message: "No loop exists." };
  if (loop.status === "paused") {
    return { decision: "paused", loop, message: "Loop is paused." };
  }
  if (loop.blocker) {
    return {
      decision: "blocked",
      loop,
      message: `Loop is blocked: ${loop.blocker.reason}`,
    };
  }
  if (loop.tick.nextRunAt !== undefined && loop.tick.nextRunAt > now) {
    return {
      decision: "wait",
      loop,
      message: `Loop is waiting until ${loop.tick.nextRunAt}.`,
    };
  }
  const retryBudget = policy.retryBudget;
  if (retryBudget !== undefined && loop.tick.consecutiveFailures > retryBudget) {
    return {
      decision: "blocked",
      loop,
      message: "Loop retry budget exhausted.",
    };
  }
  const updated = recordLoopTick(loop, input.reason ?? "manual", now);
  return {
    decision: "continue",
    loop: updated,
    message: "Loop should continue.",
    prompt: compactLoopPrompt(updated),
  };
}
