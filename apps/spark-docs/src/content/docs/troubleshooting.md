---
title: Troubleshooting
description: Diagnose TUI, daemon, session, path, and Cockpit failures in the right order.
---

## The TUI says it needs an interactive terminal

`spark` and `spark tui` require TTY stdin and stdout. For scripts or redirected
output, use a headless surface:

```bash
spark run --json "Inspect the repository."
```

## A run or Cockpit page appears stuck

Separate frontend health from daemon execution:

```bash
spark doctor
spark daemon status --json
spark daemon logs --lines 200
```

If you have an invocation identifier, inspect its status and event stream rather
than submitting the same work again.

## A session cannot be attached

Sessions are workspace-bound. Change into the same canonical workspace used to
create the session, then retry:

```bash
spark daemon session list --json
spark tui --session-id <session-id>
```

## Spark is reading unexpected configuration

Check the effective roots:

```bash
spark paths --json
```

Look for an intentionally set `SPARK_HOME` and relevant XDG variables. Do not
copy credentials or state between roots as a first repair step.

## A managed update failed

Inspect the persisted updater state before retrying:

```bash
spark update status --json
```

A failed candidate is quarantined and is not retried automatically. Use
`spark update retry <version> --yes` only after addressing the reported
failure. Rollback switches executable versions; it does not restore an old
database snapshot or discard sessions.

## Cockpit returns an error or shows no workspace

Confirm that Cockpit itself is running, then verify daemon health, workspace
registration, and the URL used by the daemon:

```bash
spark daemon status --json
spark daemon workspace ls --json
```

For remote access, confirm HTTPS, machine login, workspace registration, and
browser-key scope independently.

## Before retrying a failed external delivery

Do not assume a timeout means nothing was sent. Spark fails closed when an
external delivery outcome is uncertain. Retry only when the recorded result
proves the work was not sent or the provider supplies a deduplicated identity.
