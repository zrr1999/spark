# pi-cue

Reusable Pi extension that exposes cue-shell as a durable, observable execution substrate.

`pi-cue` is infrastructure: it does not depend on `spark-core` and can be used by Spark, future `pi-warp`, or any other Pi package.

## Tools

Short names are preserved from `pi-cue-shell`:

- `run`
- `jobs`
- `status`
- `kill`
- `wait`
- `cron`
- `scopes`
- `log`

The extension also disables the built-in `bash` tool on session start so command execution goes through cue-shell.
