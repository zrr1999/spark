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
`claude-opus-4.8`, `claude-sonnet-5`, `claude-fable-5`, `gpt-5.5`,
`gpt-5.5-coding-plan`, `gpt-5.6-sol`, `gpt-5.6-terra`) with
provider-specific prices in USD per million tokens, while rewriting outbound
payloads back to the gateway-required spelling (`Claude Opus 4.6`,
`Claude Opus 4.7`, `Opus 4.8 Coding Plan`, `Claude Sonnet 5`, `Fable 5`,
`gpt-5.5-coding-plan`, `gpt-5.6-sol`, `gpt-5.6-terra`).

Authentication:

- `BAIDU_ONEAPI_API_KEY` is supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

spark-ai does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.

## Cursor SDK provider (opt-in)

`@zendev-lab/spark-ai/cursor-provider` registers Cursor models through the local
`@cursor/sdk` agent runtime. It is not enabled by default. Add the provider to
`~/.spark/config.json` explicitly while retaining any existing providers:

```json
{
  "providers": [
    "@zendev-lab/spark-ai/baidu-oneapi-provider",
    "@zendev-lab/spark-ai/cursor-provider"
  ]
}
```

Cursor SDK authentication requires a Cursor user or service-account API key.
Configure it as `CURSOR_API_KEY` in the environment that launches Spark, or save
it through Spark's native API-key auth flow under provider `cursor`. Do not put
the key in `config.json`, project files, command history, or the model catalog
cache. Cursor CLI/Desktop login and subscription state are not reused.

List discovered or fallback Cursor models:

```console
spark --list-models cursor
```

Select a tested context/fast variant and Spark thinking level:

```console
spark --model cursor/composer-2.5@1m:fast --thinking high
spark --model cursor/composer-2.5@272k:slow --thinking xhigh
```

Context qualifiers such as `@1m` and `@272k` are model identities because they
change Spark's context-window accounting. `:fast` and `:slow` are selection-only
Cursor parameter variants. Spark thinking remains the separate `--thinking`
control; the provider maps it to Cursor `reasoning`, `effort`, or boolean
`thinking` parameters only when the live/fallback catalog exposes them.

Model discovery uses `Cursor.models.list({ apiKey })`. Public model metadata is
cached for 24 hours at `$SPARK_HOME/cursor-sdk-model-list.json` (normally
`~/.spark/cursor-sdk-model-list.json`) under an API-key fingerprint; the key
itself is never stored. Missing auth, an empty catalog, or a discovery failure
uses a checked-in fallback catalog so model selection remains inspectable.
Actual runs still require valid Cursor SDK auth.

### Cursor provider limitations

- **local-only runtime**: this adapter creates only a local Cursor SDK agent.
- **unknown/zero cost accounting**: token counts are used when attributable,
  but cost stays zero because the SDK does not expose model prices.
- **Cursor-native settings/MCP/tool** behavior is deliberately constrained:
  ambient setting sources, custom tools, and MCP bridges are not supplied.
  Cursor's own local-agent tools remain SDK-owned and are not represented as
  Spark tool calls.
- There is **no Spark tool bridge**, **no Cursor Cloud**, no native Cursor replay
  cards, and no local-agent resume/lifecycle commands.
- The provider is **not enabled by default**. It must remain opt-in until the
  Cursor-native tool safety boundary has been reviewed with live evidence.
- This is not feature parity with `pi-cursor-sdk`; Pi-only `/cursor-*` commands,
  replay UI, bridge behavior, and cloud lifecycle controls are unsupported.

### Live acceptance and dependency boundary

With an existing `CURSOR_API_KEY` or Spark-stored API key for provider `cursor`,
run the real discovery and stream path without placing the key on the command
line:

```console
SPARK_CURSOR_LIVE_TEST=1 pnpm exec node --experimental-strip-types scripts/spark-cursor-live-acceptance.mts
```

Expected secret-free JSON has provider `cursor`, catalog source `live`, a
concrete model id, stop reason `stop`, and text `SPARK_CURSOR_LIVE_OK`. The
script uses temporary cache state, self-rejects output containing the resolved
key or credential-shaped fields, and never changes user config or auth.

Spark model discovery and streaming are TypeScript in
`packages/spark-ai/src/cursor-model-discovery.ts` and
`packages/spark-ai/src/cursor-stream.ts`. Spark depends on exact
`@cursor/sdk@1.0.23`; that upstream SDK declares five platform-specific runtime
packages for Darwin, Linux, and Windows, and its use is governed by Cursor
Terms of Service. There is **no Spark Rust or native implementation** for
Cursor discovery or streaming, and Spark source does not load `.node`, FFI, or
native-addon modules directly.

### Maintainer rollout checklist

Before adding Cursor to Spark's default providers, all items must be complete:

- [ ] Package checks pass for `@zendev-lab/spark-ai` and the root TypeScript graph.
- [ ] Mocked tests pass for catalog conversion, stream event order, cancellation,
      prompt images, auth resolution, and secret redaction.
- [ ] An opt-in live run succeeds with a disposable workspace and reviewed
      filesystem/network effects.
- [ ] Redaction verification confirms no key, bearer token, cookie, or session
      credential appears in errors, cache data, artifacts, or logs.
- [ ] Cursor-native tool safety review approves local tools, sandbox behavior,
      ambient settings/MCP isolation, and the absence of a Spark tool bridge.

Maintainer validation:

```console
pnpm exec node --experimental-strip-types --test test/spark-cursor-provider.test.ts test/spark-auth.test.ts test/spark-config.test.ts
pnpm --filter @zendev-lab/spark-ai run check
pnpm run check:tsc
```
