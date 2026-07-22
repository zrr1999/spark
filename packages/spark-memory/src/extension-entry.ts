import sparkMemoryExtension from "./extension.ts";
import type { SparkMemoryExtensionApi, SparkMemoryToolOptions } from "./extension.ts";

/**
 * Pi product entrypoint: enable legacy memory_* / scratchpad aliases.
 * Spark native hosts import `./extension` directly and leave aliases off.
 */
export default function piSparkMemoryExtension(
  pi: SparkMemoryExtensionApi,
  options: SparkMemoryToolOptions = {},
): void {
  sparkMemoryExtension(pi, { ...options, enablePiCompatAliases: true });
}
