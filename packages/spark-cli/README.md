# spark-cli

Standalone Spark-first TUI host built on the Pi SDK.

## Usage

```sh
spark
spark "initial Spark goal"
```

MVP scope is intentionally TUI-only. `spark` starts Pi SDK `InteractiveMode` with Spark resources preloaded; it does not implement `--print`, JSON, RPC, or standalone status subcommands yet.

## Built-in resources

The host disables normal Pi extension discovery for the Spark TUI and bundles these extension factories directly instead of requiring users to install them as Pi extensions. This avoids duplicate/conflicting registrations when the same Spark extensions are also present in the repo or user Pi config:

- Spark extension (`spark/extension`), including embedded pi-cue tool registration
- pi-roles extension (`pi-roles/extension`)
- pi-graft extension (`pi-graft/extension`)
- Spark CLI host shim for title/status and Spark-first input routing
- Baidu OneAPI provider (`baidu-oneapi`) for Anthropic Messages-compatible Claude Opus models

Normal Pi skill discovery is also disabled for the Spark TUI; Spark skills are loaded explicitly from `packages/spark/skills` through the SDK resource loader.

## Baidu OneAPI provider

The standalone host registers a dedicated `baidu-oneapi` provider before Spark resources load. It exposes local adaptive-friendly model ids (`claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`) while rewriting outbound Anthropic payloads back to the gateway-required spelling (`Claude Opus 4.6`, `Claude Opus 4.7`, `Claude Opus 4.8`).

Authentication:

- In the TUI, run `/login`, select `Use an API key`, choose `Baidu OneAPI`, and paste the gateway API key. The key is stored under the dedicated `baidu-oneapi` provider.
- `BAIDU_ONEAPI_API_KEY` is also supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

Spark CLI does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`. Migrate by selecting the dedicated `Baidu OneAPI` provider in `/login` or by setting `BAIDU_ONEAPI_API_KEY`.

## Input routing

Non-empty interactive input that does not start with `/` or `!` is routed as `/spark <input>`. Slash commands such as `/plan`, `/execute`, and `/workflow:ready` keep their normal command behavior, and shell input remains untouched.

## Child role-run policy

For the MVP, child role-runs launched by Spark task/workflow execution continue to use the existing Pi JSON runner policy from `spark-runtime` / `pi-roles`:

- `spark-runtime` defaults role execution to `piCommand: "pi"`.
- `pi-roles` builds child role-run args as `pi --print --mode json ...`.
- Spark CLI itself is TUI-only, so it must not be used as the JSON child runner yet.

This means `pi` must remain installed and authenticated for background/child role-runs in the MVP. A future SDK in-process executor can replace this policy once Spark CLI supports a non-TUI child execution backend.
