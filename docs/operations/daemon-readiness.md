# Spark daemon readiness gate

`scripts/spark-daemon-readiness.mts` classifies Spark daemon state for Pi-replacement readiness.

## Run

```bash
pnpm run check:daemon-readiness
```

This package script emits an audit report and exits 0 unless the script itself crashes. Use strict mode when warnings should fail automation:

```bash
pnpm exec node --experimental-strip-types scripts/spark-daemon-readiness.mts --strict
```

Evaluate a saved daemon JSON fixture and compute queue deltas against a baseline fixture:

```bash
pnpm exec node --experimental-strip-types scripts/spark-daemon-readiness.mts \
  --baseline-json daemon-status-before.json \
  --status-json daemon-status-after.json
```

When no `--baseline-json` is supplied, the gate still emits `queue.delta.*` checks, but marks them `warn` because deltas cannot be computed.

## Criteria

| Field | Pass | Warn | Fail |
|---|---|---|---|
| `daemonRunning` | `true` | — | missing or not `true` |
| `enrolled` | `true` | missing or not `true` | — |
| `workspaceCount` | number greater than `0` | missing or `0` | — |
| `serverUrl` | HTTP(S) URL present | missing or non-HTTP(S) | — |
| `queue.inbox` | `0` | missing or greater than `0` | — |
| `queue.processed` | numeric counter present | missing | — |
| `queue.failed` | `0` | missing or greater than `0` | — |
| `queue.delta.inbox` | current-baseline delta `<= 0` | missing baseline/current value or delta `> 0` | — |
| `queue.delta.processed` | current-baseline delta `>= 0` | missing baseline/current value or delta `< 0` | — |
| `queue.delta.failed` | current-baseline delta `0` | missing baseline/current value or delta not `0` | — |
| `websocketState` / `ws` / `websocket` / `wsState` | `connected` | missing or non-`connected` | — |

Overall status is:

- `fail` when any check fails;
- `warn` when no check fails but at least one check warns;
- `pass` when all checks pass.

## Redaction

The output recursively replaces values for keys matching `/token|secret|key/i` with `<redacted>`. This keeps fields such as `runtimeTokenExpiresAt` and `refreshTokenExpiresAt` visible only as redacted marker values.

## Current validation expectation

In the current environment, `pnpm exec spark daemon status --json` reports a running daemon, a valid server URL, and non-zero processed work. It also reports a non-zero `queue.failed` counter, and the JSON status does not expose websocket connection state. Without a baseline file the gate also warns for `queue.delta.*` because deltas cannot be computed. The readiness gate should therefore produce an overall `warn` status until failed queue items are inspected, queue deltas are measured, and websocket readiness is represented explicitly.
