# @zendev-lab/spark-daemon

Spark daemon service for Spark-backed workspace execution. Public operator commands are routed through the unified `spark daemon` command group.

```bash
# from the Spark monorepo root
pnpm install -g .
spark daemon status
# authorize this daemon machine once, then register any of its workspaces
spark daemon login --server-url http://127.0.0.1:5173
spark daemon workspace register /path/to/workspace --server-url http://127.0.0.1:5173
# one-time workspace tokens remain available for bootstrap/automation
printf '%s\n' "$SPARK_WORKSPACE_REGISTRATION_TOKEN" | spark daemon workspace register /path/to/workspace --server-url http://127.0.0.1:5173 --token -
spark daemon workspace stop <workspace-name>
cd /path/to/workspace && spark daemon
```

Omit `/path/to/workspace` only for interactive registration; the CLI prompts for
the path instead of assuming the current directory. Non-interactive registration
should pass the path explicitly. Use `--token -` to read a one-line workspace
registration token from stdin instead of placing the secret in shell history.
`spark daemon login` uses browser/device authorization and stores the machine
credential in the private daemon config. Additional workspaces registered from
that daemon machine reuse the credential when they target the same Cockpit.
`localhost` and `127.0.0.1` refer to the daemon machine; use a reachable Cockpit
host or IP when the daemon and Cockpit run on different machines. Remote Cockpit
URLs must use HTTPS; `--allow-insecure-http` is an explicit escape hatch for a
trusted private network and must be supplied to both `login` and `workspace register`.
`spark daemon workspace stop` pauses one workspace directory without stopping the Spark
daemon. If service credentials already exist, the CLI wakes the Spark daemon so
Spark Cockpit can observe the detached state. Running `spark daemon` from inside
that directory re-attaches it.

The Spark daemon connects to a Spark Cockpit server over the daemon/server protocol,
routes task execution through Spark runtime primitives, and reports workspace,
task, invocation, ask, and artifact projections back to the web cockpit. Daemon
background role execution injects Spark's native headless role executor into
`@zendev-lab/spark-runtime`; it does not spawn `pi --print --mode json` for
cockpit task starts. Queued `session.run` work is also executed in-process via
Spark's public headless session executor. Spark Cockpit SQLite stores projections/cache;
Spark stores remain the execution source of truth.
