import type { CommandMetadata } from "@zendev-lab/spark-core";
import type { ReviewerRunner } from "./reviewer-runner.ts";
import type { SparkEntryApplicationDeps } from "./spark-entry-application.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import type { SparkDaemonDriverControl } from "./spark-daemon-driver-client.ts";

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
      authority?: "runtime_control" | "runtime_data";
      trust?: "trusted" | "untrusted";
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
  driverControl: SparkDaemonDriverControl;
  createReviewerRunner?: (
    cwd: string,
    ctx: SparkToolContext,
  ) => ReviewerRunner | Promise<ReviewerRunner>;
}

export type ForegroundDriverErrorScope = "driver" | "goal loop" | "loop" | "repro";
