# spark-cue

Reusable Spark extension package that exposes cue-shell as a durable, observable execution substrate.

`@zendev-lab/spark-cue` is infrastructure: it stays independent from Spark product packages and can be reused by Spark extension hosts.

## Transport profiles

`@zendev-lab/spark-cue` uses cue-shell's client transport resolver (`cue-client target resolve --json`, falling back to `cue client target resolve --json`). It supports both local Unix socket profiles and SSH profiles.

Spark preserves the host `PATH` and also searches the standard user install locations used by cue-shell's supported installers: `UV_TOOL_BIN_DIR`, `~/.local/bin`, and `${CARGO_HOME:-~/.cargo}/bin`. This keeps native TUI and daemon sessions independent of the narrower `PATH` commonly inherited from GUI launchers and service managers.

For SSH profiles, `@zendev-lab/spark-cue` spawns the system OpenSSH client as:

```text
ssh <destination> <gateway_command>
```

The gateway command is usually `cued gateway --stdio`, so the Node client speaks the same length-prefixed IPC protocol through the SSH stdio stream. Remote daemon startup remains explicit: `@zendev-lab/spark-cue` does not run `start_command` or auto-start remote `cued`; start it separately, for example with `ssh host "cued start"`. If the remote gateway is unavailable, the tool fails loudly with bounded trailing SSH stderr diagnostics.

When an SSH profile is active, daemon-side paths such as `cwd` and Python `script_run` paths must exist on the remote host. `cue_run` reads its `.cue` source locally and sends the body over IPC, so its path is only a source label on the remote side. Pi file tools still operate on the local workspace.

Session handshakes omit credential-like environment variables by default, including tokens, passwords, API/access keys, cookies, DSNs, and common database URLs. Set `SPARK_CUE_FORWARD_SENSITIVE_ENV=1` only for an explicitly trusted target that must inherit them. `cue_scope` always redacts sensitive values before returning environment text to the model.

## Tools

Resource-oriented tools:

- `cue_exec` — execute commands and create cue-shell jobs through the active transport profile. Tool/API runs use the current Pi session working directory by default and pipe mode (`pty: false`) by default; with SSH profiles the working directory must be valid on the remote host. Set `pty: true` only when a command genuinely needs terminal semantics. Foreground aborts and timeouts cancel the daemon execution and wait for it to stop; only `background: true` detaches. Foreground output is tailed to 16 KiB per stream by default; `tail_bytes` must be positive. Typed results expose per-stream `encoding` and `truncated` metadata; non-UTF-8 output keeps exact base64 alongside an explicitly lossy text view. Pass resource requirements with `needs` (for example `{ gpu: 1, gpu_mem: "24GiB" }`) instead of embedding `:run(need...)` in the command string.
- `cue_run` — run a `.cue` file via cue-shell script mode, mirroring `cue run <file.cue>`. Top-level items execute sequentially and fail fast; successful no-output items are summarized instead of expanded one-by-one.
- `cue_script` — run an inline `.cue` script body. Use this when the script content is generated in the Pi session; prefer `cue_run` when a real `.cue` file exists on disk.
- `script_run` — run a script file with an explicit `language`. First batch supports `cue-shell` and `python`; `cue-shell` delegates to RunScript, while `python` runs through `uv run --script <path>` (or `uv run --python <venv>/bin/python --script <path>` when `venv` is supplied) in the selected cue-shell transport environment.
- `script_eval` — run an inline script body with an explicit `language`. Inline Python is piped to `uv run --script -` so it runs as a uv script in the selected cue-shell transport environment; `venv` selects `<venv>/bin/python` via `uv run --python <venv>/bin/python --script -` and is valid only for `language: "python"`. Tool-call rendering shows a fixed, bounded preview of the leading inline code.
- `cue_jobs` — list, inspect, wait for, and stop jobs via `action`. List output is limited to 20 rows by default and includes `pending_reason` when a job is waiting for resources; chain status/wait output prioritizes failed/running/non-clean leaves and summarizes clean successful leaves.

Cancelled job, chain-leaf, and state-change records keep the structured
`cancelReason` (`User`, `ChainAborted`, or `Timeout`) while the compatibility
status remains `Cancelled`.
- `cue_resources` — inspect resource providers and snapshots via `action: "providers"` or `action: "resources"`.
- `cue_schedule` — add/list/pause/resume/remove scheduled or one-shot jobs. List output is limited to 20 rows by default.
- `cue_scope` — inspect or update the current session scope. It supports list/env/config/status, env set/unset, PATH prepend, cwd changes, and explicit host refresh. Scope lists omit env unless requested; sensitive values are always redacted from model-visible output.
- `cue_history` — recent history only by default; `limit` and `tail_bytes` are passed to `cued` when supported and must be positive.

The extension also disables the built-in `bash` tool on session start so command execution goes through cue-shell.

## Resource-gated commands

```text
cue_resources(action="providers")
cue_resources(action="resources")
cue_exec(command="uv run --script train.py", needs={ gpu: 1, gpu_mem: "24GiB" }, background=true)
cue_exec(command="run-licensed-tool", needs={ license: 1 })
```

Use `needs` for resource requirements. Do not include `:run(need.gpu=1)` in `command`; `@zendev-lab/spark-cue` already wraps `command` in `:run(...)` and encodes `needs` as `need.<key>=<quantity>` mode params.
