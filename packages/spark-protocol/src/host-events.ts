import { z } from "zod";

/**
 * Host runtime builtin lifecycle event names (SparkHostRuntime.on / emit).
 *
 * Distinct from:
 * - turn-loop subscriber events (`SparkAgentLoopEvent` in spark-turn)
 * - protocol view/daemon wire events (`SparkViewModelEvent` / `SparkDaemonEvent`)
 *
 * Do not invent a fourth event vocabulary; extend this list or the protocol
 * view/daemon unions when adding cross-surface facts.
 */
export const SPARK_HOST_BUILTIN_EVENT_NAMES = [
  "session_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_call",
  "tool_result",
  "user_message",
  "assistant_message",
] as const;

export const sparkHostBuiltinEventNameSchema = z.enum(SPARK_HOST_BUILTIN_EVENT_NAMES);

export type SparkHostBuiltinEventName = (typeof SPARK_HOST_BUILTIN_EVENT_NAMES)[number];

/**
 * Payload shapes for builtin host events. Payloads remain intentionally loose
 * (`unknown`) until each emitter is tightened; the map still gives keyof-typed
 * `on` / `emit` signatures so event names cannot silently drift.
 */
export type SparkHostBuiltinEventPayloadMap = {
  session_start: unknown;
  agent_end: unknown;
  turn_start: unknown;
  turn_end: unknown;
  tool_call: unknown;
  tool_result: unknown;
  user_message: unknown;
  assistant_message: unknown;
};

/** Turn-loop subscriber event discriminants (spark-turn `SparkAgentLoopEvent`). */
export const SPARK_AGENT_LOOP_EVENT_TYPES = [
  "stream_event",
  "user_message",
  "runtime_message",
  "prompt_manifest",
  "tool_result",
  "turn_complete",
  "run_outcome",
  "view_event",
  "abort",
  "error",
] as const;

export const sparkAgentLoopEventTypeSchema = z.enum(SPARK_AGENT_LOOP_EVENT_TYPES);

export type SparkAgentLoopEventType = (typeof SPARK_AGENT_LOOP_EVENT_TYPES)[number];

/** Terminal statuses for spark-turn `SparkRunOutcome` (in-process, not daemon invocation status). */
export const SPARK_RUN_OUTCOME_STATUSES = ["completed", "aborted", "failed"] as const;

export const sparkRunOutcomeStatusSchema = z.enum(SPARK_RUN_OUTCOME_STATUSES);

export type SparkRunOutcomeStatus = (typeof SPARK_RUN_OUTCOME_STATUSES)[number];

/**
 * Cockpit/session activity phase projected from daemon pendingTurns + session
 * view status. Subset of `sparkViewModelStatusSchema`.
 */
export const SPARK_SESSION_ACTIVITY_PHASES = ["idle", "queued", "running"] as const;

export const sparkSessionActivityPhaseSchema = z.enum(SPARK_SESSION_ACTIVITY_PHASES);

export type SparkSessionActivityPhase = (typeof SPARK_SESSION_ACTIVITY_PHASES)[number];
