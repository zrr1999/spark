/**
 * Re-export of the canonical provider registry surface from `@zendev-lab/spark-ai`.
 *
 * The higher-level provider-plugin registry, provider config/model types, and
 * the active-selection shape moved to the `spark-ai` package so any host or
 * runtime can drive provider plugins without importing spark-tui app internals.
 * This module stays as a stable internal import path for the spark-tui host.
 */

export {
  SparkProviderRegistry,
  type ProviderConfig,
  type ProviderModelDefinition,
  type ProviderRegistrationAPI,
  type SparkActiveSelection,
} from "@zendev-lab/spark-ai";
