# spark-cli

Standalone Spark-first TUI host built directly on `@earendil-works/pi-tui`.

## Usage

```sh
spark
spark "initial Spark goal"
spark --print "headless Spark prompt"
spark daemon status --json
spark daemon start
spark daemon submit --session <id> --prompt "follow-up work"
spark daemon queue --state inbox
spark --help
```

`spark` launches a Spark-owned terminal UI by default, but user prompts are submitted to the single Spark daemon over local IPC. `spark --print` and `spark daemon submit` use the same headless `turn.submit` path. The CLI no longer owns a separate queue worker/runtime and does not embed the Pi coding-agent runtime, Pi SDK `InteractiveMode`, Pi's package discovery runtime, or any gateway/HTTP service manager.

## Native host wiring

The CLI boot path now separates presentation from execution:

- `apps/spark/src/cli.ts` parses the root command and submits TUI/headless prompts through the daemon client.
- `apps/spark/src/cli/daemon.ts` starts/wakes the Spark daemon and calls local IPC methods (`daemon.status`, `daemon.queue`, `turn.submit`).
- `apps/spark/src/native-tui.ts` owns only terminal rendering/input buffering through `@earendil-works/pi-tui` primitives (`ProcessTerminal`, `TUI`, `Editor`).
- `apps/spark-daemon/src/core/*` owns daemon lock, JSON file queue, worker loop, and queued `session.run` execution.
- `apps/spark/src/host/*` still contains native host/session helpers used by daemon session execution and tests, but ordinary CLI/TUI entrypoints do not construct them directly.

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
spark daemon start [--json]
spark daemon status [--json]
spark daemon submit --session <id> --prompt <text> [--reset] [--json]
spark daemon queue [--state inbox|processed|failed|all] [--json]
spark --print <prompt>
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

These features are native Spark CLI responsibilities and should not be added to `packages/spark/src/extension/`:

- TUI process/editor lifecycle.
- Local transcript rendering and queued follow-up handling.
- Model picker/cycling UI and active provider/model persistence.
- Native JSONL session file storage/resume helpers.
- Terminal daemon client presentation, prompt submission, and local transcript rendering.
- Spark CLI skill discovery rooted at builtin/workspace/user `skills` directories.
- Explicit builtin extension loading for the native host.

Shared extension behavior should stay in extension packages and target `@zendev-lab/pi-extension-api` so the same extension can run on both hosts.

## Baidu OneAPI provider

The package contains the standalone `baidu-oneapi` provider implementation for Spark's native model runtime. It exposes local adaptive-friendly model ids (`claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-fable-5`, `gpt-5.5`, `gpt-5.5-coding-plan`) with provider-specific prices in USD per million tokens, while rewriting outbound payloads back to the gateway-required spelling (`Claude Opus 4.6`, `Claude Opus 4.7`, `Opus 4.8 Coding Plan`, `Fable 5`, `gpt-5.5-coding-plan`).

Authentication:

- `BAIDU_ONEAPI_API_KEY` is supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

Spark CLI does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.

## Headless role execution

Spark CLI now exposes `@zendev-lab/spark-cli/headless-role-executor` for daemon-native role execution. The Spark daemon injects that executor into `@zendev-lab/spark-runtime`, so cockpit-triggered background tasks run through the same in-process Spark agent loop instead of spawning `pi --print --mode json`.

`@zendev-lab/pi-roles` remains available as a legacy generic launcher for hosts that do not inject a native executor, but it is no longer the Spark daemon execution path.
