# spark-cli

Standalone Spark-first TUI host built directly on `@earendil-works/pi-tui`.

## Usage

```sh
spark
spark "initial Spark goal"
spark daemon status --json
spark daemon enqueue --session <id> --prompt "follow-up work"
spark daemon queue --state inbox
spark daemon run --once
spark --help
```

`spark` launches a Spark-owned terminal UI by default. `spark daemon ...` is a local-only daemon/queue surface for detached session-run work. It does not embed the Pi coding-agent runtime, Pi SDK `InteractiveMode`, Pi's package discovery runtime, or any gateway/HTTP/service manager.

## Native host wiring

The CLI boot path constructs Spark-owned host services before opening the TUI:

- `SparkHostRuntime` for the shared `@zendev-lab/pi-extension-api` surface.
- `SparkExtensionLoader` for explicit builtin extension factories: `@zendev-lab/pi-ask`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-roles`, `@zendev-lab/pi-graft`, and `@zendev-lab/spark`.
- `SparkProviderRegistry` plus provider plugins from `~/.spark/config.json#providers[]`.
- `SparkModelSelector` and `SparkKeybindings` for active model persistence and shortcuts.
- `SparkSessionStore` for Pi-compatible JSONL sessions under `~/.spark/sessions/<workspaceHash>/`.
- `SparkSkillResolver` for builtin/workspace/user skill discovery.
- `SparkAgentLoop` and `SparkAgentSession` for `@earendil-works/pi-ai` turns, session resume, and Spark tool dispatch.
- `host/daemon/*` for local daemon lock, JSON file queue, worker loop, and queued `session.run` execution.

The terminal loop/editor/transcript are owned by `@earendil-works/pi-tui` primitives (`ProcessTerminal`, `TUI`, `Editor`). Input is queued inside Spark CLI while a response is processing, so follow-up submissions do not hit Pi's old `Agent is already processing` runtime path.

## Configuration

Default config path:

```text
~/.spark/config.json
```

Default shape:

```json
{
   "extensions": [
      "@zendev-lab/pi-ask/extension",
      "@zendev-lab/pi-cue/extension",
      "@zendev-lab/pi-roles/extension",
      "@zendev-lab/pi-graft/extension",
      "@zendev-lab/spark/extension"}]} –––– err1 + no corr? Wait JSON malformed due extra. Need resend proper. Need not mention? Use commentary tool call only. The previous malformed not executed? We need call correct. –––– (analysis) }        (analysis) Need produce correct tool call.        (commentary to=functions.edit )      (json)      {
   ],
   "providers": ["@zendev-lab/spark-cli/baidu-oneapi-provider"],
   "activeProvider": "baidu-oneapi",
   "activeModel": "claude-opus-4.8"
}
```

Keybindings live at `~/.spark/agent/keybindings.json` and override host defaults by binding id.

## Local daemon

The daemon surface is intentionally local and file-backed:

```sh
spark daemon status [--json]
spark daemon enqueue --session <id> --prompt <text> [--json]
spark daemon queue [--state inbox|processed|failed|all] [--json]
spark daemon run [--once] [--cwd <dir>]
```

State lives under `~/.spark` by default:

- `runtime/daemon.lock` — exclusive daemon PID/start record with stale-lock recovery.
- `daemon/inbox/*.json` — queued `session.run` tasks.
- `daemon/processed/*.json` — successfully executed tasks.
- `daemon/failed/*.json` — failed tasks with persisted error text.
- `sessions/<workspaceHash>/*.jsonl` — resumed/created Spark session records.

`session.run` tasks are de-duplicated by active session id inside one daemon process so the same JSONL session is not appended concurrently. This slice does not implement gateway HTTP, bearer tokens, remote job APIs, systemd/launchd installation, or Pi RPC wrapping.

## Host-only features

These features are native Spark CLI responsibilities and should not be added to `packages/spark/src/extension/`:

- TUI process/editor lifecycle.
- Local transcript rendering and queued follow-up handling.
- Model picker/cycling UI and active provider/model persistence.
- Native JSONL session file storage/resume helpers.
- Local daemon lock/queue/worker loop and queued session-run execution.
- Spark CLI skill discovery rooted at builtin/workspace/user `skills` directories.
- Explicit builtin extension loading for the native host.

Shared extension behavior should stay in extension packages and target `@zendev-lab/pi-extension-api` so the same extension can run on both hosts.

## Baidu OneAPI provider

The package contains the standalone `baidu-oneapi` provider implementation for Spark's native model runtime. It exposes local adaptive-friendly model ids (`claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-fable-5`) while rewriting outbound Anthropic payloads back to the gateway-required spelling (`Claude Opus 4.6`, `Claude Opus 4.7`, `Opus 4.8 Coding Plan`, `Fable 5-R7M41BBSGB`).

Authentication:

- `BAIDU_ONEAPI_API_KEY` is supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

Spark CLI does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.

## Child role-run policy

For now, child role-runs launched by existing Spark task/workflow packages continue to use the existing Pi JSON runner policy from `@zendev-lab/spark-runtime` / `@zendev-lab/pi-roles`:

- `@zendev-lab/spark-runtime` defaults role execution to `piCommand: "pi"`.
- `@zendev-lab/pi-roles` builds child role-run args as `pi --print --mode json ...`.

That policy is separate from the `spark` TUI host. A future native Spark executor can replace it once Spark CLI has a non-TUI child execution backend.
