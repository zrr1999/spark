# @zendev-lab/spark-daemon

Spark daemon `spark-daemon` CLI/service for Spark-backed workspace execution.
This package is the hard-cut daemon identity for the former local runtime
adapter. Navia/cockpit protocol package names may remain until the separate
cockpit vocabulary cutover, but they are projection boundaries rather than a
parallel runtime.

```bash
npm install -g @zendev-lab/spark-daemon
spark-daemon daemon status
spark-daemon workspace register /path/to/workspace --server-url http://127.0.0.1:5173 --token <token>
printf '%s\n' "$NAVIA_TOKEN" | spark-daemon workspace register /path/to/workspace --server-url http://127.0.0.1:5173 --token -
spark-daemon workspace stop <workspace-name>
cd /path/to/workspace && spark-daemon
```

Omit `/path/to/workspace` only for interactive registration; the CLI prompts for
the path instead of assuming the current directory. Non-interactive registration
should pass the path explicitly. Use `--token -` to read a one-line workspace
registration token from stdin instead of placing the secret in shell history.
`spark-daemon workspace stop` pauses one workspace directory without stopping the Spark
daemon. If service credentials already exist, the CLI wakes the Spark daemon
so Navia can observe the detached state. Running `spark-daemon` from inside that
directory re-attaches it.

The Spark daemon connects to a Navia server over the daemon/server protocol,
routes task execution through Spark runtime primitives, and reports workspace,
task, invocation, ask, and artifact projections back to the web cockpit. Daemon
background role execution injects Spark's native headless role executor into
`@zendev-lab/spark-runtime`; it does not spawn `pi --print --mode json` for
cockpit task starts. Queued `session.run` work is also executed in-process via
Spark's public headless session executor. Navia SQLite stores projections/cache;
Spark stores remain the execution source of truth.

On install/start/status/workspace commands, the daemon performs a one-time
idempotent import from pre-cutover local daemon paths when the new Spark daemon
state is absent, then cleans stale old runtime socket/pid/lock files. It does
not keep old command aliases or a second queue worker alive.
