# spark-cli

Thin dispatcher package for the root `spark` command.

## Usage

```sh
spark
spark tui "initial Spark goal"
spark --print "headless Spark prompt"
spark daemon status --json
spark daemon workspace ls --json
spark --help
```

The dispatcher does not own terminal rendering, daemon execution, provider/model state, or host runtime code. It only routes:

- `spark` and `spark tui ...` to the interactive Spark TUI surface.
- `spark --print ...` to the same TUI app in headless submit mode.
- `spark daemon ...` to the Spark daemon administration surface.

Unknown subcommands fail loudly and suggest `spark tui ...` for prompt text. The `@zendev-lab/spark-daemon` package remains an implementation dependency; users should prefer the public `spark daemon ...` command group.
