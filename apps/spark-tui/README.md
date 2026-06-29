# spark-tui-app

Standalone Spark-first TUI app (`@zendev-lab/spark-tui-app`) built through the Spark-owned `@zendev-lab/spark-tui` boundary backed by `@earendil-works/pi-tui`.

## Usage

```sh
spark-tui
spark-tui "initial Spark goal"
spark-tui --print "headless Spark prompt"
spark-tui --mode json --print "headless Spark prompt"
spark-tui --mode rpc
spark-tui --list-models [search]
spark-tui install|remove|update|list|config [resource]
spark-tui --help

# Usually reached through the thin dispatcher:
spark
spark tui "initial Spark goal"
spark --print "headless Spark prompt"
```

`spark-tui` launches a Spark-owned terminal UI by default, and user prompts are submitted to the single Spark daemon over local IPC. `spark-tui --print` uses the same headless `turn.submit` path; `--mode json --print` emits Pi-style JSONL lifecycle/queue events around daemon acceptance. `--mode rpc` exposes a daemon-first JSONL command loop: prompt/get_state are backed by daemon IPC today, while get_messages/abort/new_session return compatibility placeholders because queued daemon turns are owned by the Spark daemon/session worker. The root `spark` command is a thin dispatcher in `apps/spark-cli` that routes `spark tui ...`, Pi-style top-level resource commands, and `spark daemon ...` to their app surfaces; it does not own TUI/runtime logic.

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
      "@zendev-lab/pi-files/extension",
      "@zendev-lab/spark-ai/models-extension",
      "@zendev-lab/pi-roles/extension",
      "@zendev-lab/pi-graft/extension",
      "@zendev-lab/spark-extension/extension"
   ],
   "providers": ["@zendev-lab/spark-ai/baidu-oneapi-provider"],
   "activeProvider": "baidu-oneapi",
   "activeModel": "claude-opus-4.8"
}
```

Keybindings live at `~/.spark/agent/keybindings.json` and override host defaults by binding id. Config-backed resource lists live in `~/.spark/config.json`: `extensions`, `providers`, `skills`, `promptTemplates`, `themes`, `contextFiles`, and `trustedWorkspaces`. `spark-tui install/remove/list/config` manages those lists without silently fetching or deleting secrets.

Prompt templates are Spark-native Markdown files loaded non-recursively from `~/.spark/prompts/*.md`, `<workspace>/.spark/prompts/*.md`, and any configured `promptTemplates` file/directory paths. The file stem becomes `/name`; optional frontmatter `description` and `argument-hint` feed slash autocomplete, and Pi-style `$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:N}`, and `${@:N:L}` substitutions expand before the prompt is submitted.

`/export html [session-id|path] [output.html]` writes a self-contained, theme-aware, escaped HTML transcript for the visible or persisted session. `/share [session-id|path] [output.html]` writes the same safe local HTML artifact under Spark's share/export area by default and never uploads secrets automatically.

Themes are Spark-native JSON files loaded from `~/.spark/themes/*.json` plus any configured `themes` paths. Builtins are `dark` and `light`; set the active theme with `/settings set theme <id>` or `activeTheme` in config. User theme files may define `id`, `label`, `mode`, optional `extends` (`dark`/`light`), and partial `colors` overrides for role, markdown, border, and diff colors.

## Native editor/input parity notes

The native Spark TUI uses the real `pi-tui` editor path. Important Pi-compatible input behavior:

- `@path` references are expanded before submission into `<file name="...">...</file>` context blocks. Image paths (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) are attached as image placeholders with the original file name.
- Terminal drag/paste usually inserts a plain path or `file://...` URL; Spark treats raw pasted image paths the same as `@image` references. Clipboard binary image extraction remains terminal/platform dependent, so unsupported terminals should paste/drag the image file path instead of silently expecting binary clipboard capture.
- `!command` runs the command through the user's shell and submits captured stdout/stderr as context. `!!command` runs the command but records only a folded shell tool result in the transcript, so command output is not submitted to the model.
- `Shift+Enter` inserts a multiline newline through `pi-tui`. When a turn is busy, plain `Enter` queues a steering update for the previous turn, while `Alt+Enter` queues the text as a follow-up turn. Windows Terminal users who cannot send `Alt+Enter` should bind an alternate key in `~/.spark/agent/keybindings.json` or use the platform-specific terminal remapping for that chord.
- `Escape` aborts the active turn and restores queued input to the editor. `Alt+Up` restores queued input without aborting. `/stop` also restores queued input instead of discarding it.

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

The `@zendev-lab/spark-ai` package contains the standalone `baidu-oneapi` provider implementation for Spark's native model runtime (`@zendev-lab/spark-ai/baidu-oneapi-provider`). It exposes local adaptive-friendly model ids (`claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-fable-5`, `gpt-5.5`, `gpt-5.5-coding-plan`) with provider-specific prices in USD per million tokens, while rewriting outbound payloads back to the gateway-required spelling (`Claude Opus 4.6`, `Claude Opus 4.7`, `Opus 4.8 Coding Plan`, `Fable 5`, `gpt-5.5-coding-plan`).

Authentication:

- `BAIDU_ONEAPI_API_KEY` is supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

spark-ai does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.

## SDK / embedding surface

`@zendev-lab/spark-tui-app` exports native SDK building blocks for embedders that do not want to spawn a subprocess:

```ts
import { createSparkCliHostServices, SparkAgentSession, SparkHostRuntime } from "@zendev-lab/spark-tui-app";
```

The exported surface covers host service construction, `SparkAgentSession`, session store/navigation primitives, provider/model registries, config/resource helpers, and the native `SparkHostRuntime` extension API implementation. This is the Spark-native counterpart to Pi's SDK examples while preserving daemon-first/session-store behavior.

## Headless role execution

Spark TUI app exposes `@zendev-lab/spark-tui-app/headless-role-executor` for daemon-native role execution. The Spark daemon injects that executor into `@zendev-lab/spark-runtime`, so cockpit-triggered background tasks run through the same in-process Spark agent loop instead of spawning `pi --print --mode json`.

`@zendev-lab/pi-roles` remains available as a legacy generic launcher for hosts that do not inject a native executor, but it is no longer the Spark daemon execution path.
