# @zendev-lab/spark-daemon

Spark's local execution service. Public operator commands use `spark daemon`.

```bash
spark daemon status
spark daemon login --server-url http://127.0.0.1:5173
spark daemon workspace register /path/to/workspace --server-url http://127.0.0.1:5173 --token <workspace-token>
spark daemon workspace stop <workspace-name>
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
spark daemon restart --yes
```

Use `--token -` to read a one-line registration token from stdin. Browser/device login stores a private machine credential for connectivity and refresh only; every workspace registration consumes a fresh workspace token. A successful registration prints a separate one-time browser key for `/{slug}/login`. Mint additional workspace browser keys with `spark daemon workspace access create`. Cockpit-level remote login uses `spark cockpit access create` and `/login`. Remote Cockpit URLs require HTTPS unless both login and registration explicitly use `--allow-insecure-http` on a trusted private network.

The daemon owns workspace arbitration, persistent sessions, channels, SQLite invocations/events, per-session execution fencing, cancellation, timeout, restart recovery, and the runtime WebSocket uplink. Cockpit receives projections; it is not execution truth.

`spark daemon restart` requests a drain restart. Before admission closes, the daemon starts an external watchdog and atomically persists a restart fence with an exact restart ID and target process generation. Queued work stays durable; active invocations finish in the current process; the successor becomes active only after scheduled work, direct invocations, and already-received channel admissions are idle. The command returns after acceptance so a daemon-hosted caller cannot wait on its own invocation; use `--wait` from an external shell to require the fenced replacement RPC identity to become ready.

An unplanned daemon exit has a different safety boundary: a durable invocation left `running` is marked `DAEMON_EXECUTION_INTERRUPTED`, because its external effects are uncertain. It is never replayed automatically. Inspect those effects and use the explicit invocation retry operation when retrying is safe. Invocations that were still `queued` remain eligible for the next daemon generation.
