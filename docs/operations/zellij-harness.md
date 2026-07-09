# Spark zellij harness

This harness probes whether a local zellij session can drive Spark native TUI and daemon validation without relying on Pi as the primary operator.

Zellij is an **operator/terminal compatibility harness**, not the primary product-correctness mechanism. High-signal Spark assertions should live in contract/golden-path tests, and TUI product correctness should prefer a first-party debug driver like cue-shell's `cue-tui --debug-socket` smoke (`just tui-debug-smoke` in `/Users/zhanrongrui/workspace/zendev-lab/cue-shell`). Keep zellij checks focused on visible pane launch, subscribe/capture availability, and cleanup behavior.

## Entry point

Preferred TUI debug harness (cue-shell):

```bash
pnpm run check:cue-harness
```

This audits `cue-tui --debug-socket` CLI surfaces. Use `--backend cue` on the zellij harness wrapper for cue-only runs:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts --backend cue --strict
```

Zellij fallback (operator compatibility):

```bash
pnpm run check:zellij-harness
```

This package script emits a non-strict audit report for the default `spark` session. Pass script arguments through pnpm for targeted captures:

```bash
pnpm run check:zellij-harness -- --session spark
```

Optional pane capture:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --session spark \
  --pane-id terminal_1 \
  --subscribe-timeout-ms 2000
```

Strict mode exits non-zero when required control capabilities are missing:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts --session spark --strict
```

## Daemon session resume/attach recipe

Use zellij as the outer session manager and Spark daemon sessions as the durable conversation/project state. The smallest resume flow is:

```bash
zellij --session spark run -- spark tui
spark daemon session list --json
spark tui --session-id <session-id>
```

Expected invariants:

- `spark daemon session list --json` is diagnostic; default session selection remains current-workspace scoped.
- `spark tui --session-id <session-id>` attaches only to a session from the same canonical cwd/workspace hash.
- Closing or detaching the zellij/TUI pane must not stop the daemon-managed persistent session.
- Use `zellij --session spark subscribe --pane-id <pane> --scrollback 20 --format raw` to capture visible resume/attach status.

The dedicated subscribe-control scenario writes a stable report used by focused tests and task evidence. It launches a temporary Spark pane in the existing `spark` session, probes the unsupported `subscript` command, verifies `subscribe`, sends `/help`, captures pane text, closes the owned pane, and compares Spark daemon status before/after:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --scenario zellij-subscribe-control \
  --session spark \
  --output /tmp/spark-zellij-subscribe-control-report.json
```

Opt-in Spark native TUI exercise mode creates a temporary zellij pane, launches `spark tui`, sends a slash command, optionally sends one ordinary input, captures output, then sends `/exit` for cleanup:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --session spark \
  --pane-id terminal_1 \
  --exercise-spark-tui \
  --slash-command /help
```

Ordinary input is intentionally opt-in because it may trigger a real Spark model/daemon turn:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --session spark \
  --pane-id terminal_1 \
  --exercise-spark-tui \
  --slash-command /help \
  --ordinary-input "status of this Spark replacement harness"
```

Use a floating pane for a wider/normal-width capture while keeping the existing layout intact:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --session spark \
  --pane-id terminal_1 \
  --subscribe-timeout-ms 3000 \
  --exercise-spark-tui \
  --exercise-floating \
  --exercise-width 90% \
  --exercise-height 70% \
  --slash-command /help
```

When the Spark task graph lives outside the repository-local `.spark` directory, pass the state root explicitly so the zellij-launched native TUI shows the same project/task graph as `task_read`. The `--spark-session-dir` value is forwarded to `spark tui --session-dir` and is treated by the native host as both Spark host home and explicit Spark state root for project/session binding:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --session spark \
  --pane-id terminal_1 \
  --subscribe-timeout-ms 3000 \
  --exercise-spark-tui \
  --spark-session-dir /path/to/task-graph/.spark \
  --exercise-floating \
  --exercise-width 90% \
  --exercise-height 70% \
  --spark-session-id 5ad35e499eafe941 \
  --slash-command /status
```

The session id is the Spark session directory suffix, e.g. `.spark/sessions/session-5ad35e499eafe941/state.json` maps to `--spark-session-id 5ad35e499eafe941`.

## Scripted Pi-extension manual matrix

Use this when validating that the current workspace package still works when loaded by Pi, not only by Spark-native tests. It creates an isolated temporary Pi home and workspace, points Pi package discovery at this repository, loads `packages/pi-extension/src/extension/index.ts`, and manually exercises the public facade plus internal implementation routes with reviewer/native execution stubs:

```bash
pnpm exec node --experimental-strip-types scripts/spark-pi-extension-manual-matrix.mts \
  --output /tmp/spark-pi-extension-manual-matrix.json
```

Expected report invariants:

- `pi --offline --help` and `pi --offline --list-models baidu` exit successfully with the temp Pi settings pointing at this repo.
- Public Pi facade tools are registered: `task_read`, `task_write`, `assign`, `goal`, `loop`, `repro`, `drive`, `phase`, `workflow_run`, `learning`, and `context`.
- Commands/events/shortcut/renderers are registered, including `/workflow`, `session_start`, `shift+tab`, and `spark-role-run-completion`.
- A temp project/task/todo lifecycle reaches `done` through canonical `task_write`/`task_read` with reviewer-stub approval.
- `workflow_run`, `run_status`, `assign --dry-run`, `learning`, `context`, widget placement, and the `Evidence/review:` widget line are all visible in the report.

Focused regression check:

```bash
pnpm exec node --experimental-strip-types --test test/spark-pi-extension-manual-matrix.test.ts
```

## What it checks

The harness emits one JSON report containing:

- zellij binary/version discovery.
- `zellij attach <session> --create-background` session bootstrap result.
- parseable `zellij list-sessions --short --no-formatting` output.
- Spark daemon status before and after the probe via `pnpm exec spark daemon status --json` with token/secret/key fields redacted.
- external action capability using `zellij --session <session> action list-panes --json --all --command --state --tab`.
- external run capability using `zellij --session <session> run --close-on-exit -- echo spark-zellij-run-probe`.
- `subscript` availability probe; zellij 0.44.3 reports that `subscript` is not a command and suggests `subscribe`.
- optional external `subscribe` capture using `zellij --session <session> subscribe --pane-id <pane> --scrollback 20 --format raw`.
- optional Spark native TUI pane exercise using external `run`, `write-chars`, `send-keys`, and `subscribe`, with `/exit` cleanup.

## Current local control result

On this machine, zellij 0.44.3 exposes `subscribe`, `pipe`, `run`, and `action`. After `zellij attach spark --create-background`, external commands such as these work against the existing `spark` session:

```bash
zellij --session spark action list-panes --json --all --command --state --tab
zellij --session spark run --close-on-exit -- echo spark-zellij-run-probe
zellij --session spark subscribe --pane-id terminal_1 --scrollback 20 --format raw
```

This means the selected strategy is:

```text
external-action
```

The installed zellij still has no `subscript` command; it reports `Did you mean 'subscribe'?`. Harness/docs should use `subscribe` for pane render updates and record `subscript` as an unsupported state, not as a required control primitive.

## Cleanup rules

Safe inspection commands:

```bash
zellij list-sessions --short --no-formatting
pnpm exec spark daemon status --json
```

Destructive cleanup is allowed only for isolated test sessions, never for a user-owned `spark` session without explicit opt-in:

```bash
zellij kill-session <isolated-test-session>
```

## Sample success output

A successful strict run has `blockers: []`, records daemon invariants, and shows temporary pane cleanup commands:

```json
{
  "sessionName": "spark",
  "paneId": "terminal_1",
  "capabilities": {
    "zellijAvailable": true,
    "sessionVisible": true,
    "externalActionWorks": true,
    "externalRunWorks": true,
    "subscribeWorks": true,
    "subscriptExists": false
  },
  "daemonChecks": {
    "daemonRunningBefore": true,
    "daemonRunningAfter": true,
    "runtimeStable": true,
    "workspaceCountStable": true,
    "queueCountersMonotonic": true,
    "mismatches": []
  },
  "sparkTuiExercise": {
    "paneId": "terminal_9",
    "slashCommand": "/help",
    "ordinaryInput": "zellij-harness-ordinary-input-smoke",
    "capture": {
      "command": "zellij --session spark subscribe --pane-id terminal_9 --scrollback 20 --format raw",
      "code": 0,
      "stdout": "/workflow-restart —\nDynamic workflow\nrestart..."
    },
    "cleanup": [
      { "command": "zellij --session spark action write-chars --pane-id terminal_9 /exit", "code": 0 },
      { "command": "zellij --session spark action close-pane --pane-id terminal_9", "code": 0 }
    ]
  },
  "selectedStrategy": "external-action",
  "blockers": [],
  "unsupportedStates": [
    "Installed zellij does not provide `subscript`; use `subscribe` for pane render updates."
  ]
}
```

## Sample failure output

A missing pane id is reported as a structured blocker and exits non-zero in strict mode:

```json
{
  "sessionName": "spark",
  "paneId": "terminal_999999",
  "commands": {
    "subscribeProbe": {
      "command": "zellij --session spark subscribe --pane-id terminal_999999 --scrollback 20 --format raw",
      "code": 2,
      "stderr": "Pane terminal_999999 not found\n"
    }
  },
  "capabilities": {
    "subscribeWorks": false
  },
  "daemonChecks": {
    "daemonRunningBefore": true,
    "daemonRunningAfter": true,
    "runtimeStable": true,
    "workspaceCountStable": true,
    "queueCountersMonotonic": true,
    "mismatches": []
  },
  "blockers": [
    "Subscribe capture failed for pane terminal_999999."
  ]
}
```

After the failure-mode run, verify no harness-owned panes remain:

```bash
zellij --session spark action list-panes --json --all --command --state --tab
```

The expected result is that temporary `spark-zellij-probe` panes from the success/failure probes are absent; only pre-existing user/session panes remain.

## Unsupported states

The harness reports structured blockers when:

- zellij is not installed.
- the session cannot be created or listed.
- external `action` and `run` are unavailable.
- no pane id is supplied for `subscribe` capture.
- `subscribe` fails for the supplied pane id.
- `subscript` is requested; installed zellij provides `subscribe`, not `subscript`.

## Evidence expectations

A successful full validation report must include:

- daemon status JSON before and after the run with secrets redacted;
- pane id discovery output from an in-session `zellij action list-panes --json --all --command --state --tab` command;
- captured native TUI output for a slash command and ordinary prompt;
- exit codes for all validation commands;
- cleanup commands used or intentionally skipped with reason.
