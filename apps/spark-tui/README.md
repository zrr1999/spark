# spark-tui-app

Standalone Spark-first TUI app (`@zendev-lab/spark-tui-app`) built through the Spark-owned `@zendev-lab/spark-tui` boundary backed by `@earendil-works/pi-tui`.

## Usage

```sh
spark-tui
spark-tui "initial Spark goal"
spark-tui --print "headless Spark prompt"
spark-tui --help

# Usually reached through the thin dispatcher:
spark
spark tui "initial Spark goal"
spark --print "headless Spark prompt"
```

`spark-tui` launches a Spark-owned terminal UI by default, but user prompts are submitted to the single Spark daemon over local IPC. `spark-tui --print` uses the same headless `turn.submit` path. The root `spark` command is a thin dispatcher in `apps/spark-cli` that routes `spark tui ...` and `spark daemon ...` to their app surfaces; it does not own TUI/runtime logic.

## Native host wiring

The TUI boot path separates presentation from execution:

- `apps/spark-tui/src/cli.ts` parses the TUI command and submits TUI/headless prompts through the daemon client.
- `apps/spark-tui/src/cli/daemon.ts` starts/wakes the Spark daemon and calls local IPC methods (`daemon.status`, `daemon.queue`, `turn.submit`).
- `apps/spark-tui/src/native-tui.ts` owns only terminal rendering/input buffering through the `@zendev-lab/spark-tui` boundary and `apps/spark-tui/src/tui/pi-tui-adapter.ts`.
- `apps/spark-daemon/src/core/*` owns daemon lock, JSON file queue, worker loop, and queued `session.run` execution.
- `apps/spark-tui/src/host/*` still contains native host/session helpers used by daemon session execution and tests, but ordinary CLI/TUI entrypoints do not construct them directly.

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
      "@zendev-lab/spark-extension/extension"
   ],
   "providers": ["@zendev-lab/spark-tui-app/baidu-oneapi-provider"],
   "activeProvider": "baidu-oneapi",
   "activeModel": "claude-opus-4.8"
}
```

Keybindings live at `~/.spark/agent/keybindings.json` and override host defaults by binding id.

## Local daemon

The daemon surface is intentionally local and file-backed:

```sh
spark daemon start [--json]
spark daemon status [--json]
spark daemon submit --session <id> --prompt <text> [--reset] [--json]
spark daemon queue [--state inbox|processed|failed|all] [--json]
spark-tui --print <prompt>
```

Daemon state follows the Spark daemon XDG paths (`$SPARK_DAEMON_*`, then `$XDG_*`, then `~/.local/state|share|cache/spark/daemon`):

- `daemon.lock` — exclusive daemon PID/start record with stale-lock recovery.
- `daemon.sock` — local IPC socket for status/queue/submit.
- `daemon/inbox/*.json` — queued `session.run` tasks.
- `daemon/processed/*.json` — successfully executed tasks.
- `daemon/failed/*.json` — failed tasks with persisted error text.
- `sessions/<workspaceHash>/*.jsonl` — resumed/created Spark session records.

`session.run` tasks are de-duplicated by active session id inside one daemon process so the same JSONL session is not appended concurrently. This slice does not expose a second Spark CLI worker, gateway HTTP, bearer tokens, remote job APIs, or Pi RPC wrapping.

## Host-only features

These features are native Spark TUI app responsibilities and should not be added to `packages/spark-extension/src/extension/`:

- TUI process/editor lifecycle.
- Local transcript rendering and queued follow-up handling.
- Model picker/cycling UI and active provider/model persistence.
- Native JSONL session file storage/resume helpers.
- Terminal daemon client presentation, prompt submission, and local transcript rendering.
- Spark TUI app skill discovery rooted at builtin/workspace/user `skills` directories.
- Explicit builtin extension loading for the native host.

Shared extension behavior should stay in extension packages and target `@zendev-lab/pi-extension-api` so the same extension can run on both hosts.

## Baidu OneAPI provider

The package contains the standalone `baidu-oneapi` provider implementation for Spark's native model runtime. It exposes local adaptive-friendly model ids (`claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-fable-5`, `gpt-5.5`, `gpt-5.5-coding-plan`) with provider-specific prices in USD per million tokens, while rewriting outbound payloads back to the gateway-required spelling (`Claude Opus 4.6`, `Claude Opus 4.7`, `Opus 4.8 Coding Plan`, `Fable 5`, `gpt-5.5-coding-plan`).

Authentication:

- `BAIDU_ONEAPI_API_KEY` is supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

Spark TUI app does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.

## Headless role execution

Spark TUI app exposes `@zendev-lab/spark-tui-app/headless-role-executor` for daemon-native role execution. The Spark daemon injects that executor into `@zendev-lab/spark-runtime`, so cockpit-triggered background tasks run through the same in-process Spark agent loop instead of spawning `pi --print --mode json`.

`@zendev-lab/pi-roles` remains available as a legacy generic launcher for hosts that do not inject a native executor, but it is no longer the Spark daemon execution path.
