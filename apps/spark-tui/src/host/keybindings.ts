/**
 * Thin compatibility adapter for Spark host keybindings.
 *
 * The shared keybinding registry used by SparkHostRuntime lives in
 * @zendev-lab/spark-host/keybindings. This file preserves the historical
 * spark-tui host import path.
 */

export {
  SparkKeybindings,
  defaultKeybindingsPath,
  defaultSparkKeybindings,
} from "@zendev-lab/spark-host/keybindings";
export type {
  SparkKeybindingContext,
  SparkKeybindingDefinition,
  SparkKeybindingId,
  SparkKeybindingsOptions,
  SparkKeybindingsSnapshot,
} from "@zendev-lab/spark-host/keybindings";
