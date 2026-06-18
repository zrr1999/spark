# @navia-dev/runner

Navia `navia` CLI and local service daemon for Spark-backed workspace execution.
The package still carries the historical runner name internally because it owns
the runtime adapter boundary between Navia's server protocol and Spark runtime
primitives.

```bash
npm install -g @navia-dev/runner
navia daemon status
navia ws register /path/to/workspace --server-url http://127.0.0.1:5173 --token <token>
printf '%s\n' "$NAVIA_TOKEN" | navia ws register /path/to/workspace --server-url http://127.0.0.1:5173 --token -
navia ws stop <workspace-name>
cd /path/to/workspace && navia
```

Omit `/path/to/workspace` only for interactive registration; the CLI prompts for
the path instead of assuming the current directory. Non-interactive registration
should pass the path explicitly. Use `--token -` to read a one-line workspace
registration token from stdin instead of placing the secret in shell history.
`navia ws stop` pauses one workspace directory without stopping the local
service. If service credentials already exist, the CLI wakes the local service
so Navia can observe the detached state. Running `navia` from inside that
directory re-attaches it.

The local service connects to a Navia server over the runner/server protocol,
routes task execution through Spark runtime primitives, and reports workspace,
task, invocation, ask, and artifact projections back to the web cockpit. Navia
SQLite stores projections/cache; Spark stores remain the execution source of
truth.
