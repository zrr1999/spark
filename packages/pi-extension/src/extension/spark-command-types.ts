import type { CommandMetadata } from "@zendev-lab/spark-extension-api";
import type { ReviewerRunner } from "./reviewer-runner.ts";
import type { SparkEntryApplicationDeps } from "./spark-entry-application.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export type SparkGoalLoopContext = SparkToolContext & {
  waitForIdle?: () => Promise<void>;
  setEditorText?: (text: string) => void;
};

export interface SparkCommandContext extends SparkGoalLoopContext {}

export interface SparkCommandApi {
  registerCommand(
    name: string,
    config: {
      description: string;
      argumentHint?: string;
      metadata?: CommandMetadata;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) =>
        | Array<{ value: string; label: string; description?: string }>
        | null
        | Promise<Array<{ value: string; label: string; description?: string }> | null>;
      handler: (args: string, ctx: SparkCommandContext) => void | Promise<void>;
    },
  ): void;
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  sendUserMessage?(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void;
}

export interface SparkCommandRegistrationDeps extends SparkEntryApplicationDeps {
  createReviewerRunner?: (
    cwd: string,
    ctx: SparkToolContext,
  ) => ReviewerRunner | Promise<ReviewerRunner>;
}

export interface ForegroundGoalAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  goalId: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

export interface ForegroundLoopAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  loopId: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

export interface ForegroundReproAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  reproId: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

export interface ForegroundImplementAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  focus?: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

export type ForegroundDriverErrorScope = "driver" | "goal loop" | "loop" | "repro";
