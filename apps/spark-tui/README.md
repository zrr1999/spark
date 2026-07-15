# @zendev-lab/spark-tui-app

Spark's native terminal host. Prompts use the daemon `turn.submit` path; foreground streaming follows `turn.stream` and completion follows `turn.status`.

## Usage

```sh
spark
spark tui "initial prompt"
spark run "headless prompt"
spark run --json "headless prompt"
spark --mode rpc
spark --list-models [search]
```

Compatibility aliases include `spark-tui`, `spark --print`, and `spark-tui --print`.

## Configuration

Main config: `~/.spark/config.json`. Keybindings: `~/.spark/agent/keybindings.json`. Prompt templates load from `~/.spark/prompts/*.md`, workspace `.spark/prompts/*.md`, and configured paths. Themes load from `~/.spark/themes/*.json` and configured paths.

The native editor supports `@path`, image paths, `!command`, `!!command`, multiline input, steering, follow-ups, abort/restore, model selection, transcript export, and persisted session resume. Terminal-specific chords and binary clipboard images depend on terminal support.

## Daemon control

```sh
spark daemon status --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

Invocation status and streamed events come from the daemon. Attach and resume are restricted to the current workspace.

Use the real zellij interaction/capture procedure in [`../../docs/operations/zellij-harness.md`](../../docs/operations/zellij-harness.md) for TUI UX validation.
