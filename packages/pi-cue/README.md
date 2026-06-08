# pi-cue

Reusable Pi extension that exposes cue-shell as a durable, observable execution substrate.

`pi-cue` is infrastructure: it does not depend on `spark-*` packages and can be used by Spark, future `pi-warp`, or any other Pi package.

## Tools

Resource-oriented tools:

- `cue_exec` — execute commands and create cue-shell jobs. Tool/API runs use the current Pi session working directory by default and pipe mode (`pty: false`) by default; set `pty: true` only when a command genuinely needs terminal semantics. Foreground output is tailed to 16 KiB per stream by default (`tail_bytes: 0` for full output).
- `cue_run` — run a `.cue` file via cue-shell script mode, mirroring `cue run <file.cue>`. Top-level items execute sequentially and fail fast.
- `cue_script` — run an inline `.cue` script body. Use this when the script content is generated in the Pi session; prefer `cue_run` when a real `.cue` file exists on disk.
- `script_run` — run a script file with an explicit `language`. First batch supports `cue-shell` and `python`; `cue-shell` delegates to RunScript, while `python` runs `python3` through cue-shell job execution.
- `script_eval` — run an inline script body with an explicit `language`. Inline Python is written to a temporary file before execution.
- `cue_jobs` — list, inspect, wait for, and stop jobs via `action`. List output is limited to 20 rows by default.
- `cue_schedule` — add/list/pause/resume/remove scheduled or one-shot jobs. List output is limited to 20 rows by default.
- `cue_scope` — inspect scopes, HEAD env, or cue-shell config. Scope lists omit env unless requested.
- `cue_history` — recent history only by default; use `limit: 0` and `tail_bytes: 0` for full text.

The extension also disables the built-in `bash` tool on session start so command execution goes through cue-shell.
