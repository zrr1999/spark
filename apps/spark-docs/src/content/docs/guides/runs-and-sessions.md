---
title: Runs and sessions
description: Choose foreground, background, interactive, and resumed Spark execution.
---

## Foreground headless work

`spark run` waits for the headless run and prints its result:

```bash
spark run "Review the current diff."
spark run --json "Return a machine-readable repository summary."
```

Resume a known session when continuity matters:

```bash
spark run --resume <session-id> "Continue with the next verified step."
```

## Background work

`spark bg` submits a daemon invocation and returns its receipt. Without an
explicit session, Spark creates an invocation session identifier:

```bash
spark bg --json "Run the repository validation and report failures."
```

Submit more work to an existing session:

```bash
spark bg --session <session-id> "Re-run only the failing check."
```

Inspect the invocation through daemon commands instead of starting another
executor:

```bash
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason "No longer needed" --json
```

## Interactive sessions

List daemon sessions and attach from the same workspace:

```bash
spark daemon session list --json
spark tui --session-id <session-id>
```

Session identity preserves conversation and execution continuity. It does not
override workspace binding or permission checks.

## Which mode should you use?

- Use `spark run` for one foreground result.
- Use `spark bg` when the shell should return after durable submission.
- Use `spark` or `spark tui` for interactive exploration and steering.
- Use Cockpit to observe and control existing daemon work from the browser.
