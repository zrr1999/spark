# Spark turn protocol

`SparkCommand` is a transport-neutral intent. `SparkEvent` is a fact emitted after handling or projection. Schemas use `spark.command.v1` and `spark.event.v1`; transports adapt into these objects but do not own execution policy.

## Command and event fields

A `SparkCommand` has `kind` plus optional `id`, `route`, `payload`, `payloadRef`, `transport`, and `idempotencyKey`. Routes identify the relevant runtime, workspace, project, command, invocation, session, task runtime, local client, or path.

A `SparkEvent` has `kind` plus the relevant command, route, subject, status, payload, diagnostic, and transport fields. `diagnostic.reported` and `error.reported` include severity, code, message, and optional retryability.

Canonical vocabulary includes:

- commands: `daemon.restart.request`, `turn.submit.request`, `turn.cancel.request`, `turn.status.request`, `turn.result.request`, `turn.stream.subscribe`, `invocation.list.request`, `invocation.retry.request`, `invocation.retention.preview.request`, `workspace.register.request`, `workspace.snapshot.request`, `task.start.request`, `invocation.cancel.request`, and `diagnostics.request`;
- events: `command.accepted`, `command.status`, `command.rejected`, `projection.workspace.snapshot`, `diagnostic.reported`, and `error.reported`.

## Local RPC

The local socket is newline-delimited JSON. Requests use a transport method and may carry the equivalent `sparkCommand`.

| Method | Command kind | Result |
| --- | --- | --- |
| `turn.submit` | `turn.submit.request` | `{ invocationId, status: "queued", acceptedAt }` |
| `turn.status` | `turn.status.request` | invocation status, retry ancestry, and latest `eventCursor` |
| `turn.result` | `turn.result.request` | bounded terminal assistant text or classified error |
| `turn.stream` | `turn.stream.subscribe` | bounded events after a cursor, `nextCursor`, `hasMore` |
| `turn.cancel` | `turn.cancel.request` | `{ invocationId, status, cancelRequested }` |
| `invocation.list` | `invocation.list.request` | bounded summary page filtered by status, session, and creation time |
| `invocation.retry` | `invocation.retry.request` | a new queued invocation with `retryOfInvocationId` |
| `invocation.retention.preview` | `invocation.retention.preview.request` | dry-run terminal history eligible under consumer cursors |
| `daemon.status` | `daemon.status.request` | health, lifecycle phase, process identity/generation, and invocation counts |
| `daemon.restart` | `daemon.restart.request` | idempotent fenced drain intent with restart and target-generation IDs |

Status values are `queued | running | succeeded | failed | cancelled`. Stream events contain `invocationId`, positive `sequence`, `kind`, JSON `payload`, and `createdAt`. Clients resume with `after=nextCursor`; a cursor before retained history fails explicitly.

Cancellation and execution timeout are terminal invocation transitions. `cancelRequested` reports whether cancellation was accepted, not whether an executor has already settled. A sender-side `session.question` wait timeout is different: it stops waiting and does not cancel the still-running invocation.

Invocation lists contain summaries only; task payloads, results, and events are read through their dedicated status/result/stream methods. Stable error codes determine `retryable`. Explicit retry never mutates the failed terminal row: it creates a new invocation and persists `retryOfInvocationId`. Automatic replay of a model/tool invocation is disabled: its external side-effect boundary is not generally idempotent.

Transport recovery is separate from execution replay. `turn.submit` uses one stable idempotency key and retries local RPC unavailable/timeout/pre-response-close failures with capped jitter and no attempt limit. After acceptance, status and stream reads retry the same transient failures without resubmitting; the invocation ID and successful stream cursor stay fixed. Caller deadline or cancellation ends the local wait, not the already accepted invocation. Remote validation, protocol, and unsupported-daemon errors fail immediately.

Inside an accepted invocation, transient provider request failures may retry without an attempt-count limit only while the abortable model-stream execution budget remains active. Model streams use idle hang detection (default 45 minutes without stream events) rather than a short wall-clock stream cutoff; a positive wall-clock stream timeout remains optional. Cancellation or an explicit execution deadline still stops them. When the daemon process is replaced after an unplanned exit, durable `running` invocations are requeued for resume against persisted session state with a resume notice for the model; invalid task payloads still fail closed.

Retention is preview-only until an operator applies a separate cleanup policy. A terminal invocation with events is eligible only after every registered delivery consumer has advanced past its latest event; the summary and final error remain the durable diagnostic record.

Restart is asynchronous and drain-first. An IPC-ready external watchdog and atomically persisted restart fence are armed before the old process closes admission. The old process then stops claiming queued work, rejects new direct runtime execution with `DAEMON_DRAINING`, lets active invocations finish, and flushes already-received channel admissions. The detached successor helper retries startup with capped backoff and no attempt limit; only a durable cancel, completed, or superseded fence stops it. The successor must report the exact fenced restart ID, instance ID, generation, PID, and protocol version, and publishes completion only after local admission and serving loops are active. Supervised external channel connections are not readiness gates. The CLI returns after acceptance by default; an external caller may use `--wait`. Replacement preserves single ownership and therefore has a short socket handoff window rather than running two active daemon generations.

If the process crashes instead of completing a planned drain, any invocation persisted as `running` with a valid task is requeued for resume (`source_kind=invocation.resume`, `resumeFromInterrupt` on the task). The model is told the turn is a continuation so it can avoid repeating completed side effects. Invalid task payloads still fail closed with `DAEMON_EXECUTION_INTERRUPTED`. Persisted `queued` invocations remain claimable by the successor.

## Runtime WebSocket

Cockpit sends `server.command` envelopes. The daemon validates the workspace binding, adapts the payload to `SparkCommand`, and emits acknowledgements or rejections. Unknown bindings reject with `UNKNOWN_WORKSPACE_BINDING`; detached or borrowed workspaces reject disallowed mutations while still permitting diagnostics, snapshots, and cancellation.

Runtime command kinds include `workspace.snapshot.request`, `task.start.request`, `invocation.cancel.request`, `artifact.content.request`, and `human.response.deliver.request`. Execution remains daemon-owned after acceptance.

The daemon projects SQLite invocation events as `invocation.updated` and `invocation.log_chunk` envelopes with the original per-invocation `sequence`. Each envelope has a deterministic message ID derived from `(invocationId, sequence)`. The uplink sends one event at a time, advances its delivery cursor only after `server.ingest_ack`, and resumes from the last acknowledged sequence after reconnect. Cockpit deduplicates replayed envelopes by the stable message ID. Structured view or interaction events that are not invocation updates or assistant log deltas remain `daemon.event` envelopes.

## In-process prompt and run contracts

The host stores conversation input as `SparkPromptItem`, preserving authority (`system | developer | runtime_control | runtime_data | user | assistant | tool`), trust, visibility, and persistence until the provider boundary. Runtime control and untrusted runtime data are not user messages internally. Extension custom messages default to `runtime_data/untrusted`; only an explicit `runtime_control/trusted` pair is promoted to control authority. Compatibility providers that lack those roles receive an escaped, tagged data envelope only during lowering; replay and compaction retain the original metadata. Deferred `nextTurn` data is keyed by session and enters only that session's next real user turn.

Every agent submission terminates with a `SparkRunOutcome`: `completed`, `aborted`, or `failed`. The legacy `submit()` API returns its assistant envelope, while `submitWithOutcome()` and headless callers consume the explicit terminal status. `roundtrips` counts attempted model calls, including a one-call answer without tools, as an observability metric rather than a runtime limit. The loop has no roundtrip ceiling; explicit cancellation, execution deadlines, and provider/tool per-operation timeouts remain in force. Model-stream failures, aborts, and cancelled approval waits therefore cannot be mistaken for completion.

Before each model roundtrip, the turn loop emits a privacy-safe `SparkPromptManifest`. It contains prompt version and hashes/character counts, a hashed session fingerprint, model/reasoning selection, cache-key fingerprint, active resolved tool policies, selected skill names, the current roundtrip index, and the parallel-tool-call limit. It never contains prompt text, user input, tool arguments, raw session IDs, credentials, or raw cache keys, and it is an observability event rather than a conversation message. The pure behavior evaluator scores recorded manifests/outcomes/tool summaries against explicit tool, effect, evidence, and tool-count expectations, while recording roundtrip counts as a metric without imposing a ceiling.

## Invariants

- The daemon is execution truth and the local arbitration point.
- Local RPC and runtime WebSocket are transport adapters only.
- Duplicate submit requests require explicit idempotency keys.
- Event delivery and reconnect replay are at least once; consumers deduplicate by stable IDs/sequences.
- Agent-generated UI content is data and must not execute MDX, JS, JSX, imports, exports, or raw HTML.
- Runtime control/data authority is preserved until provider lowering and across replay/compaction.
- Only resolved active tool policy may authorize concurrency or suppress approval.
- Terminal run status is explicit; absence of another tool call is not sufficient evidence after an error or abort.
