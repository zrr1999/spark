# Spark turn protocol

`SparkCommand` is a transport-neutral intent. `SparkEvent` is a fact emitted after handling or projection. Schemas use `spark.command.v1` and `spark.event.v1`; transports adapt into these objects but do not own execution policy.

## Command and event fields

A `SparkCommand` has `kind` plus optional `id`, `route`, `payload`, `payloadRef`, `transport`, and `idempotencyKey`. Routes identify the relevant runtime, workspace, project, command, invocation, session, task runtime, local client, or path.

A `SparkEvent` has `kind` plus the relevant command, route, subject, status, payload, diagnostic, and transport fields. `diagnostic.reported` and `error.reported` include severity, code, message, and optional retryability.

Canonical vocabulary includes:

- commands: `daemon.restart.request`, `turn.submit.request`, `turn.cancel.request`, `turn.status.request`, `turn.stream.subscribe`, `workspace.register.request`, `workspace.snapshot.request`, `task.start.request`, `invocation.cancel.request`, and `diagnostics.request`;
- events: `command.accepted`, `command.status`, `command.rejected`, `projection.workspace.snapshot`, `diagnostic.reported`, and `error.reported`.

## Local RPC

The local socket is newline-delimited JSON. Requests use a transport method and may carry the equivalent `sparkCommand`.

| Method | Command kind | Result |
| --- | --- | --- |
| `turn.submit` | `turn.submit.request` | `{ invocationId, status: "queued", acceptedAt }` |
| `turn.status` | `turn.status.request` | invocation status and latest `eventCursor` |
| `turn.stream` | `turn.stream.subscribe` | bounded events after a cursor, `nextCursor`, `hasMore` |
| `turn.cancel` | `turn.cancel.request` | `{ invocationId, status, cancelRequested }` |
| `daemon.status` | `daemon.status.request` | health, lifecycle phase, process identity/generation, and invocation counts |
| `daemon.restart` | `daemon.restart.request` | idempotent fenced drain intent with restart and target-generation IDs |

Status values are `queued | running | succeeded | failed | cancelled`. Stream events contain `invocationId`, positive `sequence`, `kind`, JSON `payload`, and `createdAt`. Clients resume with `after=nextCursor`; a cursor before retained history fails explicitly.

Cancellation and timeout are terminal invocation transitions. `cancelRequested` reports whether cancellation was accepted, not whether an executor has already settled.

Restart is asynchronous and drain-first. An IPC-ready external watchdog and atomically persisted restart fence are armed before the old process closes admission. The old process then stops claiming queued work, rejects new direct runtime execution with `DAEMON_DRAINING`, lets active invocations finish, and flushes already-received channel admissions. The successor must report the exact fenced restart ID, instance ID, generation, PID, and protocol version before readiness succeeds. It does not replay or migrate an in-progress model turn. The CLI returns after acceptance by default; an external caller may use `--wait`. Replacement preserves single ownership and therefore has a short socket handoff window rather than running two active daemon generations.

If the process crashes instead of completing a planned drain, any invocation persisted as `running` is failed closed with `DAEMON_EXECUTION_INTERRUPTED`. Its side effects are considered uncertain and it is not automatically requeued; an operator must inspect them before using explicit retry. Persisted `queued` invocations remain claimable by the successor.

## Runtime WebSocket

Cockpit sends `server.command` envelopes. The daemon validates the workspace binding, adapts the payload to `SparkCommand`, and emits acknowledgements or rejections. Unknown bindings reject with `UNKNOWN_WORKSPACE_BINDING`; detached or borrowed workspaces reject disallowed mutations while still permitting diagnostics, snapshots, and cancellation.

Runtime command kinds include `workspace.snapshot.request`, `task.start.request`, `invocation.cancel.request`, `artifact.content.request`, and `human.response.deliver.request`. Execution remains daemon-owned after acceptance.

The daemon projects SQLite invocation events as `invocation.updated` and `invocation.log_chunk` envelopes with the original per-invocation `sequence`. Each envelope has a deterministic message ID derived from `(invocationId, sequence)`. The uplink sends one event at a time, advances its delivery cursor only after `server.ingest_ack`, and resumes from the last acknowledged sequence after reconnect. Cockpit deduplicates replayed envelopes by the stable message ID. Structured view or interaction events that are not invocation updates or assistant log deltas remain `daemon.event` envelopes.

## Invariants

- The daemon is execution truth and the local arbitration point.
- Local RPC and runtime WebSocket are transport adapters only.
- Duplicate submit requests require explicit idempotency keys.
- Event delivery and reconnect replay are at least once; consumers deduplicate by stable IDs/sequences.
- Agent-generated UI content is data and must not execute MDX, JS, JSX, imports, exports, or raw HTML.
