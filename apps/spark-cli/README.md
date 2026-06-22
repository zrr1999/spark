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

- `spark` and `spark tui ...` to the `spark-tui` executable from `@zendev-lab/spark-tui-app`.
- `spark --print ...` to `spark-tui --print ...` for backward-compatible headless prompt submission.
- `spark daemon ...` to the `spark-daemon` executable from `@zendev-lab/spark-daemon`.

Unknown subcommands fail loudly and suggest `spark tui ...` for prompt text.
