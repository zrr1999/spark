# pi-cue

Reusable Pi extension that exposes cue-shell as a durable, observable execution substrate.

`@zendev-lab/pi-cue` is infrastructure: it does not depend on `spark-*` packages and can be used by Spark, future `pi-warp`, or any other Pi package.

## Transport profiles

`@zendev-lab/pi-cue` uses cue-shell's client transport resolver (`cue-client target resolve --json`, falling back to `cue client target resolve --json`). It supports both local Unix socket profiles and SSH profiles.

For SSH profiles, `@zendev-lab/pi-cue` spawns the system OpenSSH client as:

```text
ssh <destination> <gateway_command>
```

The gateway command is usually `cued gateway --stdio`, so the Node client speaks the same length-prefixed IPC protocol through the SSH stdio stream. Remote daemon startup remains explicit: `@zendev-lab/pi-cue` does not run `start_command` or auto-start remote `cued`; start it separately, for example with `ssh host "cued start"`. If the remote gateway is unavailable, the tool fails loudly with bounded trailing SSH stderr diagnostics.

When an SSH profile is active, daemon-side paths such as `cwd`, `cue_run.path`, and script paths must exist on the remote host. Pi file tools still operate on the local workspace.

## Tools

Resource-oriented tools:

- `cue_exec` — execute commands and create cue-shell jobs through the active transport profile. Tool/API runs use the current Pi session working directory by default and pipe mode (`pty: false`) by default; with SSH profiles the working directory must be valid on the remote host. Set `pty: true` only when a command genuinely needs terminal semantics. Foreground output is tailed to 16 KiB per stream by default (`tail_bytes: 0` for full output). Pass resource requirements with `needs` (for example `{ gpu: 1, gpu_mem: "24GiB" }`) instead of embedding `:run(need...)` in the command string.
- `cue_run` — run a `.cue` file via cue-shell script mode, mirroring `cue run <file.cue>`. Top-level items execute sequentially and fail fast; successful no-output items are summarized instead of expanded one-by-one.
- `cue_script` — run an inline `.cue` script body. Use this when the script content is generated in the Pi session; prefer `cue_run` when a real `.cue` file exists on disk.
- `script_run` — run a script file with an explicit `language`. First batch supports `cue-shell` and `python`; `cue-shell` delegates to RunScript, while `python` runs `python3` or the selected `venv` interpreter through cue-shell job execution. `scope` is valid only for `language: "cue-shell"`.
- `script_eval` — run an inline script body with an explicit `language`. Inline Python is executed through `python -c` so it runs in the selected cue-shell transport environment; `venv` selects `<venv>/bin/python` and is valid only for `language: "python"`.
- `cue_jobs` — list, inspect, wait for, and stop jobs via `action`. List output is limited to 20 rows by default and includes `pending_reason` when a job is waiting for resources; chain status/wait output prioritizes failed/running/non-clean leaves and summarizes clean successful leaves.
- `cue_resources` — inspect resource providers and snapshots via `action: "providers"` or `action: "resources"`.
- `cue_schedule` — add/list/pause/resume/remove scheduled or one-shot jobs. List output is limited to 20 rows by default.
- `cue_scope` — inspect scopes, HEAD env, or cue-shell config. Scope lists omit env unless requested.
- `cue_history` — recent history only by default; `limit` and `tail_bytes` are passed to `cued` when supported. Use `limit: 0` and `tail_bytes: 0` for full text.

The extension also disables the built-in `bash` tool on session start so command execution goes through cue-shell.

## Transport profiles

`@zendev-lab/pi-cue` honors cue-shell client transport resolution through `cue-client target resolve --json` or `cue client target resolve --json`.

- Unix profiles connect to the resolved daemon socket. If the local daemon is not reachable, `@zendev-lab/pi-cue` may auto-start `cued` for that Unix socket.
- SSH profiles connect through the configured gateway command, equivalent to `ssh <destination> <gateway_command>`, and then speak the same cue-shell IPC framing over stdio.
- Remote daemon startup remains explicit. `@zendev-lab/pi-cue` does not run `start_command` for SSH profiles; start the remote daemon yourself, for example `ssh user@example.com "cued start"`.

## Resource-gated commands

```text
cue_resources(action="providers")
cue_resources(action="resources")
cue_exec(command="python train.py", needs={ gpu: 1, gpu_mem: "24GiB" }, background=true)
cue_exec(command="run-licensed-tool", needs={ license: 1 })
```

Use `needs` for resource requirements. Do not include `:run(need.gpu=1)` in `command`; `@zendev-lab/pi-cue` already wraps `command` in `:run(...)` and encodes `needs` as `need.<key>=<quantity>` mode params.
