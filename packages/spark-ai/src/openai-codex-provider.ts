import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

import { registerPiAiProvider } from "./pi-provider-adapter.ts";
import type { ProviderRegistrationAPI } from "./provider-registry.ts";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_API = "openai-codex-responses";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * Register pi-ai's maintained Codex catalog and transport in Spark's
 * host-neutral provider registry. Spark continues to own credential storage
 * and selection; pi-ai owns the provider-specific model and wire details.
 */
export default function registerOpenAICodexProvider(api: ProviderRegistrationAPI): void {
  const provider = openaiCodexProvider();
  registerPiAiProvider(api, provider, {
    authRef: `oauth:${OPENAI_CODEX_PROVIDER_ID}`,
    api: OPENAI_CODEX_API,
    baseUrl: OPENAI_CODEX_BASE_URL,
  });
}
