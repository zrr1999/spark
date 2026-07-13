/**
 * Thin compatibility adapter for the Spark turn loop.
 *
 * The core model/tool turn orchestration lives in @zendev-lab/spark-turn so
 * TUI, daemon, and headless hosts can share one implementation. This file keeps
 * the historical spark-tui host import path stable for existing callers/tests.
 */

export {
  SparkAgentLoop,
  SparkTurnRunner,
  type SparkAgentLoopEvent,
  type SparkAgentLoopOptions,
  type SparkAgentLoopState,
  type SparkAgentStreamFunction,
  type SparkToolApprovalMethod,
  type SparkToolApprovalRejectAction,
  type SparkToolApprovalReviewRequest,
  type SparkToolApprovalReviewResult,
  type SparkTurnHost,
  type SparkTurnOutboxEnvelope,
  type SparkTurnRegisteredTool,
} from "@zendev-lab/spark-turn";
