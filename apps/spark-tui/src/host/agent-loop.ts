/**
 * Thin native-host adapter for the shared Spark turn loop.
 *
 * Core model/tool orchestration remains in @zendev-lab/spark-turn. The native
 * host only adds a request-bound preparation hook so dynamic host context
 * (currently selected skills) is refreshed before a real user submit without
 * teaching the shared turn loop about skill discovery.
 */

import {
  SparkAgentLoop as SparkTurnAgentLoop,
  type SparkAgentLoopOptions as SparkTurnAgentLoopOptions,
  type SparkRunOutcome,
  type SparkTurnUserContent,
} from "@zendev-lab/spark-turn";

export interface SparkAgentLoopOptions extends SparkTurnAgentLoopOptions {
  /** Refresh request-scoped host context before accepting a real user submit. */
  prepareUserSubmit?: (content: string) => void | Promise<void>;
  /** Clear request-scoped host context after the submit settles. */
  finishUserSubmit?: () => void | Promise<void>;
}

export class SparkAgentLoop extends SparkTurnAgentLoop {
  private readonly prepareUserSubmit: ((content: string) => void | Promise<void>) | undefined;
  private readonly finishUserSubmit: (() => void | Promise<void>) | undefined;
  private preparingUserSubmit = false;

  constructor(options: SparkAgentLoopOptions) {
    const { prepareUserSubmit, finishUserSubmit, ...turnOptions } = options;
    super(turnOptions);
    this.prepareUserSubmit = prepareUserSubmit;
    this.finishUserSubmit = finishUserSubmit;
  }

  override async submitWithOutcome(content: SparkTurnUserContent): Promise<SparkRunOutcome> {
    // Let the core loop produce its canonical busy error without mutating the
    // prompt of the in-flight turn.
    if (this.getState() !== "idle") return await super.submitWithOutcome(content);
    if (this.preparingUserSubmit) {
      throw new Error(
        "SparkAgentLoop.submit refused: agent is not idle (state=preparing). " +
          "Use SparkNativeSession queueing or wait for the current turn to finish.",
      );
    }
    // Atomically block extension-triggered turns before request preparation
    // awaits. The core loop also rejects this reservation if a background
    // turn is already in its pre-stream lifecycle.
    this.beginUserSubmitPreparation();
    this.preparingUserSubmit = true;
    try {
      await this.prepareUserSubmit?.(userContentText(content));
      return await super.submitWithOutcome(content);
    } finally {
      try {
        await this.finishUserSubmit?.();
      } finally {
        this.preparingUserSubmit = false;
        this.endUserSubmitPreparation();
      }
    }
  }
}

function userContentText(content: SparkTurnUserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export {
  SparkTurnRunner,
  type SparkAgentLifecycleSource,
  type SparkAgentLoopEvent,
  type SparkAgentLoopState,
  type SparkAgentPhase,
  type SparkAgentStreamFunction,
  type SparkPromptAuthority,
  type SparkPromptItem,
  type SparkPromptManifest,
  type SparkPromptManifestOptions,
  type SparkPromptPersistence,
  type SparkPromptTrust,
  type SparkPromptVisibility,
  type SparkRunOutcome,
  type SparkToolApprovalMethod,
  type SparkToolApprovalRejectAction,
  type SparkToolApprovalReviewRequest,
  type SparkToolApprovalReviewResult,
  type SparkTurnHost,
  type SparkTurnOutboxEnvelope,
  type SparkTurnRegisteredTool,
} from "@zendev-lab/spark-turn";
