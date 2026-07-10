/**
 * Compatibility facade for the native TUI.
 *
 * Spark credentials and provider control are product mechanisms shared with
 * other local hosts; the executable TUI only adapts them to slash commands and
 * pi-tui rendering.
 */
export {
  SparkAuthStore,
  SparkProviderAuthResolver,
  defaultSparkAuthPath,
  listOAuthProviderSummaries,
  registerSparkOAuthProvider,
  resetSparkOAuthProviders,
} from "@zendev-lab/spark-ai/control";
export type {
  SparkAuthFile,
  SparkAuthStoreOptions,
  SparkOAuthProviderInterface,
  SparkProviderAuthResolverOptions,
  SparkProviderAuthStatus,
  SparkStoredCredential,
} from "@zendev-lab/spark-ai/control";
