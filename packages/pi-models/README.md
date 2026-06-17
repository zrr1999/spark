# pi-models

`@zendev-lab/pi-models` registers a read-only `models` tool for inspecting the active Pi model registry.

The tool is intentionally separate from `pi-roles`: roles may store role→model bindings, but model catalog discovery belongs to the host model registry.

## Tool surface

- `models` — list models known to the active Pi model registry.

Parameters:

- `query?: string` — case-insensitive substring filter over provider, model id, and display name.
- `provider?: string` — filter by provider, for example `openai` or `baidu-oneapi`.
- `includeUnavailable?: boolean` — defaults to `false`; when `true`, list all registered models and include an `auth` column.
- `limit?: number` — maximum rows to render.

By default, `models` mirrors `pi --list-models`: it returns only models with configured credentials.

## Host scope

The first implementation targets the upstream `pi-coding-agent` host by reading `ctx.modelRegistry`. The portable `pi-extension-api` contract and Spark CLI native host do not expose model registry access yet; on those hosts the tool reports that model-registry support is not wired.
