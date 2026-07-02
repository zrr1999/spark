# Spark turn command protocol

Status: authoritative for Spark runtime command vocabulary v1.

This spec describes the transport-neutral turn/command protocol used by the Spark daemon,
Spark TUI, and Spark Cockpit runtime uplink. It replaces the old placeholder content in this file.

## Goals

- Use one command vocabulary (`SparkCommand`) for daemon-local socket requests and Cockpit/runtime
  WebSocket commands.
- Use one event vocabulary (`SparkEvent`) for command acknowledgements, command status,
  projection facts, diagnostics, and errors.
- Keep the Spark daemon as the execution owner and local arbitration point. Transports adapt into
  commands; they do not own policy or execution truth.
- Preserve the current single-machine/offline local socket flow while allowing Cockpit to deliver
  the same intents over the runtime WebSocket.

## Protocol objects

### `SparkCommand`

A `SparkCommand` is a JSON object validated by `packages/spark-protocol/src/command-events.ts`.
It describes an intent before transport-specific routing details are handled.

Required fields:

- `schemaVersion`: `spark.command.v1`.
- `id`: a transport-scoped request or command id.
- `kind`: canonical intent name.

Common optional fields:

- `route`: ids such as `runtimeId`, `workspaceBindingId`, `workspaceId`, `projectId`,
  `commandId`, `invocationId`, `sessionId`, `taskRuntimeId`, `workspaceLocalPath`, or `clientId`.
- `payload`: JSON parameters for the intent.
- `payloadRef`: URL/content metadata for large payloads.
- `transport`: diagnostic trace of the adapter that created the command.

### `SparkEvent`

A `SparkEvent` is a JSON fact emitted after command handling or projection ingestion.
Important event kinds:

- `command.accepted`, `command.rejected`, `command.status`.
- `projection.workspace.snapshot`, `projection.task_graph.snapshot`,
  `projection.artifact.projected`, `projection.invocation.updated`,
  `projection.invocation.log_chunk`.
- `diagnostic.reported`, `error.reported`.
- `daemon.event`, `runtime.reconcile.report`.

`diagnostic.reported` and `error.reported` events must include structured diagnostic details
(`severity`, `code`, `message`, optional `retryable`).

## Transport adapters

### Daemon local socket (NDJSON)

The local socket remains an offline-compatible NDJSON transport. Requests retain their legacy
`method` for compatibility and now also carry a `sparkCommand` created from the same request.
The daemon parser synthesizes the same `SparkCommand` for old clients that do not send the field.

| Local method | Canonical command kind | Purpose |
| --- | --- | --- |
| `turn.submit` | `turn.submit.request` | Queue a local session turn. |
| `turn.cancel` | `turn.cancel.request` | Cancel an active local invocation. |
| `daemon.queue` | `turn.status.request` | Read queued/processed/failed turn status. |
| `turn.stream` | `turn.stream.subscribe` | Submit and stream local daemon events. |
| `daemon.status` | `daemon.status.request` | Read daemon health/queue summary. |
| `workspace.register` | `workspace.register.request` | Register a local workspace with a server. |
| `workspace.ensure-local` | `workspace.ensure_local.request` | Ensure an offline local workspace record. |
| `workspace.attach` / `workspace.stop` | `workspace.attach.request` / `workspace.stop.request` | Control local workspace lifecycle. |
| `workspace.client.*` | `workspace.client.*.request` | Attach/heartbeat/release interactive/headless clients. |
| `workspace.executor.ensure` | `workspace.executor.ensure.request` | Ensure a local executor client lease. |

Example local submit request:

```json
{
  "id": "rpc_turn_submit",
  "method": "turn.submit",
  "params": { "sessionId": "session-a", "prompt": "continue work" },
  "sparkCommand": {
    "schemaVersion": "spark.command.v1",
    "id": "rpc_turn_submit",
    "kind": "turn.submit.request",
    "route": { "sessionId": "session-a" },
    "payload": { "sessionId": "session-a", "prompt": "continue work" },
    "transport": { "kind": "local-rpc", "method": "turn.submit", "requestId": "rpc_turn_submit" }
  }
}
```

### Runtime WebSocket

The runtime WebSocket receives Cockpit outbox rows as `server.command` envelopes. At the daemon
adapter boundary the envelope is converted to `SparkCommand`; the rest of daemon dispatch uses the
canonical command. The old envelope shape remains only as a compatibility carrier for the bridge
adapter during migration.

| Runtime `server.command` payload kind | Canonical command kind | Purpose |
| --- | --- | --- |
| `task.start.request` | `task.start.request` | Start server-originated task execution. |
| `invocation.cancel.request` | `invocation.cancel.request` | Cancel a running runtime invocation. |
| `workspace.snapshot.request` | `workspace.snapshot.request` | Ask the daemon to project workspace state. |
| `diagnostics.request` | `diagnostics.request` | Ask the daemon to emit diagnostic output. |
| `project.create.request` | `project.create.request` | Reserved server project creation intent. |
| `artifact.content.request` | `artifact.content.request` | Reserved artifact content request intent. |

Example task start command after adaptation:

```json
{
  "schemaVersion": "spark.command.v1",
  "id": "cmd_11111111111111111111111111111111",
  "kind": "task.start.request",
  "title": "Start MVP task",
  "route": {
    "runtimeId": "rt_01234567890123456789012345678901",
    "workspaceBindingId": "rtwb_01234567890123456789012345678901",
    "workspaceId": "ws_01234567890123456789012345678901",
    "projectId": "proj_01234567890123456789012345678901",
    "commandId": "cmd_11111111111111111111111111111111"
  },
  "payload": { "prompt": "Inspect the workspace.", "source": "project-chat" },
  "transport": {
    "kind": "runtime-ws",
    "envelopeType": "server.command",
    "sourceKind": "task.start.request"
  }
}
```

## Command lifecycle contracts

### Submit

- Local socket submit (`turn.submit.request`) enqueues a `session.run` task in the daemon queue and
  returns a local RPC success result containing the queue file name/path and task payload.
- Runtime WebSocket submit (`task.start.request`) is accepted only for a workspace binding owned by
  this daemon and not currently borrowed by an interactive client. The daemon emits
  `runtime.command.ack`, `invocation.updated`, `task_graph.snapshot`, logs, and artifact projections
  as the bridge runs.
- Submit policy decisions happen in `decideSparkDaemonCommandPolicy`, not in a transport handler.

### Cancel

- Local socket cancel (`turn.cancel.request`) targets a local invocation id and returns a
  `command.status`-equivalent result: `cancelled: true/false` and a message.
- Runtime WebSocket cancel (`invocation.cancel.request`) is allowed even when the workspace is
  borrowed or detached. A successful cancel emits `runtime.command.ack` and an `invocation.updated`
  event with `status: cancelled`.

### Status

- Local socket status (`turn.status.request`) reads the daemon queue states (`inbox`, `processed`,
  `failed`, or `all`).
- Runtime WebSocket status uses `workspace.snapshot.request` for workspace projection and
  `diagnostics.request` for daemon diagnostic output.

### Errors

- Unknown workspace bindings reject with `UNKNOWN_WORKSPACE_BINDING`.
- Detached workspaces reject non-cancel commands with `WORKSPACE_DETACHED` and `retryable: true`.
- Borrowed workspaces reject server mutations with `WORKSPACE_BORROWED` and `retryable: true`, while
  still allowing snapshot, diagnostics, and cancel.
- Unsupported command kinds reject with `COMMAND_KIND_UNIMPLEMENTED`.

## Fixtures and contract tests

Canonical examples live in:

- `packages/spark-protocol/src/fixtures/command-events-v1/vocabulary-samples.json`.

The fixture currently contains:

- command samples for local `turn.submit`, local `turn.cancel`, local queue status,
  local workspace registration, runtime workspace snapshot, and runtime task start;
- event samples for command accepted, command status, workspace projection, diagnostic report,
  command rejected, and transport error.

Contract coverage lives in:

- `packages/spark-protocol/src/command-events.test.ts` for schema/mapping/fixture round trips;
- `apps/spark-daemon/src/command-dispatcher.test.ts` for local RPC, runtime WebSocket, and policy
  adapter contracts;
- `test/spark-daemon-cli.test.ts` and `test/spark-rendering.test.ts` for TUI local IPC and daemon
  slash-command behavior.

## Invariants

- `SparkCommand` and `SparkEvent` schema definitions live in `@zendev-lab/spark-protocol`.
- The daemon is the only execution truth and the only owner of workspace borrowed/detached command
  arbitration.
- Local socket and runtime WebSocket are transport adapters only.
- Existing public tool names and local socket methods remain stable during migration.
- Agent-generated UI/content must never execute MDX/JS/JSX/import/export/raw HTML as part of this
  protocol.
