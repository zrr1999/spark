# @zendev-lab/spark-ai

Host-neutral Spark provider/AI plumbing built on top of `@earendil-works/pi-ai`.

This package owns the Spark-side model/provider layer so any host (the native
spark-tui host, the daemon, tests) can drive provider plugins and model routing
without importing Spark app internals. It does not own credentials beyond
reading configured env keys, and it never imports Spark app hosts.

## Model routing contracts

Host-neutral model routing data shapes consumed by later resolver/auth-pool layers:

- `SparkModelProfile` is the stable user-facing model identity.
- `ProviderRoute` is one priority-ordered transport binding for that model.
- `SparkAuthPool` / `AuthSlot` describe named credential slots without exposing secrets.
- `RouteDecision`, `RouteTrace`, `FailureClass`, and `RouteHealth` are shared contracts for routing diagnostics and future resolver state.
- `SparkModelRegistry`, `validateSparkModelProfile`, `materializeRouteModel`, and the `retagAssistantMessage*` helpers turn validated profiles/routes into pi-ai `Model<Api>` values and re-tag transport responses with the Spark-facing identity.

Routes always carry both Spark-facing identity (the profile id) and pi-ai transport identity (`transportApi`, `transportModelId`, `provider`, and `authPoolId`). This makes gateway/provider adapters explicit instead of relying on TypeScript-only casts.

## Provider registry + runners

The higher-level provider-plugin surface used by the native host:

- `SparkProviderRegistry` (`ProviderRegistrationAPI`) caches `{name, baseUrl, apiKey, api, streamSimple, models[]}` provider plugins, validates active selection, and materializes a pi-ai `Model<Api>` per provider/model.
- `createProviderRegistryStreamFunction` adapts the active provider into a pi-ai-shaped stream function for the agent loop.
- `createProviderRegistryWorkflowModelRunner` runs a single read-only workflow model agent against a selected provider/model.
- `normalizeProviderStream` / `resolveWorkflowModelSelection` / `assistantMessageToText` are the shared helpers behind those factories.

Provider plugins default-export `function(pi: ProviderRegistrationAPI)` and are
loaded by the host the same way extensions are, but receive the provider API
surface instead of `ExtensionAPI`.

## Models tool

`@zendev-lab/spark-ai/models-extension` registers the read-only `models` tool for inspecting the active Spark host model registry. The tool lists available models by default, can include unavailable registered models with auth status, and keeps route/provider details as catalog data rather than a separate model-selection package.

## Baidu OneAPI provider

`@zendev-lab/spark-ai/baidu-oneapi-provider` is the bundled standalone
`baidu-oneapi` provider plugin for Spark's native model runtime. It exposes local
adaptive-friendly model ids (`claude-opus-4.6`, `claude-opus-4.7`,
`claude-opus-4.8`, `claude-fable-5`, `gpt-5.5`, `gpt-5.5-coding-plan`) with
provider-specific prices in USD per million tokens, while rewriting outbound
payloads back to the gateway-required spelling (`Claude Opus 4.6`,
`Claude Opus 4.7`, `Opus 4.8 Coding Plan`, `Fable 5`, `gpt-5.5-coding-plan`).

Authentication:

- `BAIDU_ONEAPI_API_KEY` is supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

spark-ai does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.
