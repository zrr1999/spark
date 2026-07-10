import type { ProviderConfig } from "./provider-registry.ts";
import {
  CURSOR_API_KEY_ENV,
  CURSOR_PROVIDER_API,
  CURSOR_PROVIDER_BASE_URL,
  CURSOR_PROVIDER_ID,
} from "./cursor-constants.ts";
import {
  discoverCursorModels,
  type CursorCatalogFallbackIssue,
  type DiscoverCursorModelsOptions,
} from "./cursor-model-discovery.ts";
import type { ProviderRegistrationAPI } from "./provider-registry.ts";
import { streamCursor } from "./cursor-stream.ts";

export {
  CURSOR_API_KEY_ENV,
  CURSOR_PROVIDER_API,
  CURSOR_PROVIDER_BASE_URL,
  CURSOR_PROVIDER_ID,
} from "./cursor-constants.ts";

export interface RegisterCursorProviderOptions extends DiscoverCursorModelsOptions {
  onCatalogFallback?: (issue: CursorCatalogFallbackIssue) => void;
  streamSimple?: ProviderConfig["streamSimple"];
}

/**
 * Register the host-neutral Cursor provider catalog.
 *
 * Cursor-native tool/MCP semantics are intentionally not bridged into Spark here. The
 * provider remains opt-in until the local runtime adapter and its safety boundary have
 * been validated. Cursor Cloud, Pi commands, replay cards, and session lifecycle code
 * from pi-cursor-sdk are outside this package boundary.
 */
export default async function registerCursorProvider(
  api: ProviderRegistrationAPI,
  options: RegisterCursorProviderOptions = {},
): Promise<void> {
  const { onCatalogFallback, streamSimple, ...discoveryOptions } = options;
  const onFallback = onCatalogFallback ?? discoveryOptions.onFallback;
  const models = await discoverCursorModels({
    ...discoveryOptions,
    ...(onFallback ? { onFallback } : {}),
  });
  api.registerProvider(CURSOR_PROVIDER_ID, {
    name: "Cursor",
    baseUrl: CURSOR_PROVIDER_BASE_URL,
    apiKey: CURSOR_API_KEY_ENV,
    api: CURSOR_PROVIDER_API,
    models,
    streamSimple: streamSimple ?? streamCursor,
  });
}
