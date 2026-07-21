/**
 * Thin compatibility adapter for the Spark SparkHostAPI host runtime.
 *
 * The host-neutral runtime lives in @zendev-lab/spark-host so TUI, daemon, and
 * headless entrypoints can share the same tool/command/event/outbox contract.
 */

export { SparkHostRuntime, createSparkHostRuntime } from "@zendev-lab/spark-host";
export type { SparkHostRuntimeOptions } from "@zendev-lab/spark-host";
