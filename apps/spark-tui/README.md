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

Spark follows the standard XDG config, data, cache, state, and runtime roots by default. Set `SPARK_HOME` only when one self-contained root is preferred:

```sh
export SPARK_HOME=/path/to/spark-home
```

With `SPARK_HOME`, the main config is `$SPARK_HOME/config.json`, credentials are `$SPARK_HOME/auth.json`, sessions are under `$SPARK_HOME/sessions/`, keybindings under `$SPARK_HOME/agent/`, prompt templates under `$SPARK_HOME/prompts/`, and themes under `$SPARK_HOME/themes/`. Spark-owned role model settings, learnings, memory, recall, exports, and share files use sibling paths under the same root. App-specific daemon/Cockpit data uses `$SPARK_HOME/apps/<app>/{data,cache,state,run}`.

Without `SPARK_HOME`, these paths use `$XDG_CONFIG_HOME/spark`, `$XDG_DATA_HOME/spark`, `$XDG_CACHE_HOME/spark`, `$XDG_STATE_HOME/spark`, and `$XDG_RUNTIME_DIR/spark` according to ownership.

Workspace state remains in the current workspace `.spark/`. Cross-harness user roles, skills, and workflows load from `~/.agents/{roles,skills,workflows}`; project roles, skills, and workflows load from `.agents/{roles,skills,workflows}`, while workspace-specific Spark skills use `.spark/skills`; saved project workflows always use `.agents/workflows`. There are no `$SPARK_HOME/skills` or `$SPARK_HOME/workflows` directories. Run `spark paths --json` to inspect effective paths without creating files.

Retired Pi and component-specific storage variables no longer influence path resolution.

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
