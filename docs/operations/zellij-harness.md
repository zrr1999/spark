# Spark zellij validation

Zellij is the required operator path for real Spark TUI interaction and capture when terminal UX is in scope. Contract tests remain responsible for non-visual behavior.

## Run

```bash
pnpm run check:zellij-harness -- --session spark
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts --session spark --strict
```

Capture an existing pane:

```bash
zellij --session spark action list-panes --json --all --command --state --tab
zellij --session spark subscribe --pane-id <pane-id> --scrollback 20 --format raw
```

The installed control surface uses `subscribe`; `subscript` is not a supported command.

## Session resume

Zellij manages the terminal process; the Spark daemon owns durable conversation state:

```bash
zellij --session spark run -- spark tui
spark daemon session list --json
spark tui --session-id <session-id>
```

Session selection is current-workspace scoped. `spark tui --session-id <session-id>` must match the canonical cwd/workspace hash. Closing or detaching the zellij/TUI pane must not stop the daemon-managed persistent session.

## Controlled scenario

The focused scenario creates a temporary pane, sends `/help`, captures visible output, closes only that pane, and compares daemon status before and after:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --scenario zellij-subscribe-control \
  --session spark \
  --output /tmp/spark-zellij-subscribe-control-report.json
```

For a full native interaction:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --session spark \
  --exercise-spark-tui \
  --exercise-floating \
  --exercise-width 90% \
  --exercise-height 70% \
  --slash-command /status
```

Add `--ordinary-input <text>` only when a real model/daemon turn is intended. Use `--spark-session-dir <path>` and `--spark-session-id <id>` when the task graph/session root is outside the current repository.

## Side Thread acceptance

Run lifecycle acceptance in an isolated Zellij session and isolated `SPARK_HOME`; do not reuse a developer daemon. The release gate is behavioral rather than visual modal parity:

1. `/btw ask <question>` reaches a terminal child invocation and `/btw show` displays the durable exchange.
2. A second submit while the child has a queued/running invocation fails with the typed busy error and creates no second invocation.
3. `spark daemon restart --yes --wait` changes the daemon process identity while preserving the current generation, transcript, and configuration.
4. `/btw model <provider>/<model>` and `/btw thinking <level>` update the effective projection; an unavailable model returns its typed configuration error.
5. `/btw handoff full ...` and `/btw handoff summary ...` each create one successful parent invocation and advance to a fresh generation.

The native command/status presentation is sufficient for this gate. The Pi-product modal overlay remains compatibility UI, not a second state owner or a prerequisite for retiring that product host.

## Evidence

A valid report includes:

- daemon status before and after, with secrets redacted;
- pane discovery and the captured visible TUI output;
- exit codes for launch, input, capture, and cleanup;
- stable daemon identity and nondecreasing terminal invocation counts;
- `blockers: []` for strict success.

## Cleanup

Never kill a user-owned `spark` session. Close only harness-created panes with `/exit` and `close-pane`. `zellij kill-session` is allowed only for an isolated test session created for that run.
