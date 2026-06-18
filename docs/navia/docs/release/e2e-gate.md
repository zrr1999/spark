# Runner end-to-end gate

Historical standalone `pnpm release:e2e` (and the umbrella `pnpm release:gate`)
drives the **real `spark-daemon` daemon** end-to-end against an isolated,
project-local Navia server. In the merged Spark repo, prefer the Spark-root
`pnpm run spark-daemon:e2e`, `pnpm run verify:cockpit`, and `pnpm run verify:merged`
gates; this document remains the contract for the runner/server happy path in
[release-roadmap.md](../plans/release-roadmap.md).

This is different from `pnpm release:smoke` (alias `pnpm smoke:runner`), which
exercises the **simulator** path: a fake runner sending pre-baked workspace,
inbox, task graph, invocation, and artifact projections to validate the
server-side projection schema.

## What the gate verifies

The gate covers Gate B "Real task happy path":

1. Boot an isolated SvelteKit + SQLite server on a temp data root and a
   randomly allocated port.
2. Mint a workspace registration token via the same `createRuntimeEnrollmentToken`
   helper Settings uses.
3. Register a real `spark-daemon` daemon **in-process** against the server,
   using the runtime registration API and the enrollment token.
4. Register a local workspace directory under a temp root and let the daemon
   open the runtime WebSocket, send `runtime.hello`, and start its heartbeat.
5. Wait for `runtime_workspace_bindings` to contain an `available` row for the
   runtime.
6. Create the local owner session, create a server-visible workspace bound to
   the runner workspace binding, and create a project under it.
7. Submit `task.start.request` via the project cockpit `?/startTask` form
   action.
8. Wait for the daemon to ack, stream agent log chunks, transition through the
   running snapshot, project a `task-summary` artifact, and emit the final
   `succeeded` `invocation.updated`.
9. Assert that `mirrored_invocations`, `invocation_log_chunks`,
   `task_graph_tasks`, and `artifacts` rows reflect the runner's output.

If any of those steps fail, the gate exits non-zero with a descriptive error.

## Execution modes

The merged Spark repo validates the daemon command path with injected/stubbed
Spark bridge behavior by default, so CI does not need provider credentials. That
stubbed path still exercises daemon command-handling, log streaming, snapshot,
artifact-projection, and server ingestion paths.

Legacy standalone real-Pi mode remains documented for compatibility, but the
preferred product contract is now the Spark runtime bridge: runner task starts
must call Spark runtime primitives and then project Spark-owned run/task/artifact
state back into Navia.

The stubbed mode is the right default for CI and for the per-PR release gate,
because the gate's value is verifying the **runner/server/projection contract**
end-to-end rather than re-validating an upstream provider SDK on every change.

## Commands

```bash
pnpm run spark-daemon:e2e       # Spark-root stubbed runner happy path
pnpm run verify:cockpit    # Navia check + test + build
pnpm run verify:merged   # Spark boundaries/tsc/tests plus Navia verify

# Historical standalone compatibility commands:
pnpm release:e2e
pnpm release:gate
```

Useful flags:

- `--keep-data` — keep the temp server, runner, and workspace dirs for
  inspection. Paths are printed at the end.
- `--task-timeout-ms <ms>` — bump the task lifecycle wait window for slow
  models or laptops.
- `--server-timeout-ms <ms>` — bump the server boot wait window.

## Environment used at runtime

The gate creates three temp roots:

- `spark-daemon-e2e-XXXX` — server data/cache/state (`NAVIA_SERVER_DATA_DIR`,
  `NAVIA_SERVER_CACHE_DIR`, `NAVIA_SERVER_STATE_DIR`).
- `spark-daemon-e2e-home-XXXX` — runner `HOME`/data/cache/state directories.
- `spark-daemon-e2e-workspace-XXXX` — local workspace directory the runner
  binds to.

All three are removed on a clean run unless `--keep-data` is passed.

## CI integration

A minimal CI job that wants to gate merges should run:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm release:gate
```

`verify:merged` and the retained release gates are intentionally hermetic: they
do not depend on the host's Navia install, provider credentials, network access
(beyond loopback), or any project-local `.navia/` data. The simulator smoke and
stubbed runner E2E together exercise the full server projection schema and the
real runner command-handling path.

For occasional release-branch runs, follow up with a provider-authenticated
operator smoke when provider behavior itself must be validated.

## Where this fits in release-roadmap.md

- **P0.4 Validation gate script** — the gate replaces the old "real runner E2E
  is still pending" caveat with a green pre-release check.
- **P1.6 / P1.8** — confirms Spark-runtime-backed execution and minimal task
  result projection are wired together.
- **Gate B / Gate D** — `release:gate` is the boring, repeatable command line
  of those gates.

When Gate C work lands (HITL ask bridge and artifact content bridge), this
gate should grow assertions for human request projections and runner-served
artifact content rather than fork into a separate script.
