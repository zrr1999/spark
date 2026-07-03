# RFC: Spark Cockpit projection store boundary

Status: selected for Spark monorepo migration
Date: 2026-06-17

## Summary

Spark Cockpit's SQLite database is a local web-cockpit projection/cache. It is
not the authoritative task, run, artifact, ask, or review store for Spark
execution. Spark `.spark/` stores remain the execution source of truth; Cockpit
stores enough mirrored state to render the UI, route runtime protocol messages,
reconnect safely, and cache artifact previews.

## Source-of-truth matrix

| Area | Authoritative owner | Cockpit SQLite role | Replay/idempotency key |
| --- | --- | --- | --- |
| Workspaces, local owner bindings, runtime registrations, auth sessions | Spark Cockpit server/runtime registration flow | Authoritative local setup and routing state | `workspaces.slug`, `runtime_workspace_bindings(runtime_id, local_workspace_key)`, active owner binding unique index |
| Cockpit projects | Spark Cockpit server UI/product flow | Authoritative dashboard grouping and command-routing records in `projects`; these rows are **not** Spark task graph projects. Spark project refs may appear only as metadata/projection links. | `projects(workspace_id, slug)` plus `metadata_json.sourceOfTruth = "spark-cockpit-routing"` for user-created rows |
| Workspace resources and profile inventory | Spark Cockpit workspace profile/import flow | Authoritative local setup/catalog state in `resources`, `project_resources`, `agent_specs`, `workspace_profile_sources`, and `workspace_profile_git_access` | Workspace/profile uniqueness and import upserts |
| Command queue and delivery attempts | Spark Cockpit server runtime protocol broker | Authoritative delivery bookkeeping in `commands` and `command_deliveries`; command execution state remains Spark-owned after Spark daemon ack/start | `commands(workspace_id, idempotency_key)` and delivery id |
| Spark tasks/TODOs/plans/runs | Spark task graph APIs and `.spark/projects.json` / run stores | Projection only: `task_graph_snapshots`, `task_graph_clusters`, `task_graph_tasks`, `task_graph_dependencies` | Runtime message receipt plus `task_graph_snapshots(runtime_workspace_binding_id, runtime_snapshot_id)` |
| Invocations / role-run status | Spark runtime/role-run state | Projection only: `mirrored_invocations`, `invocation_events`, `invocation_log_chunks` | Runtime message receipt plus `mirrored_invocations(runtime_workspace_binding_id, runtime_invocation_id)` and `invocation_log_chunks(invocation_id, stream, sequence)` |
| Artifacts / evidence body | Spark artifact store (`@zendev-lab/spark-artifacts`) | Projection/cache metadata: `artifacts`, `artifact_links`, optional `artifact_cache_blobs` preview/body cache | Runtime message receipt plus artifact id upsert and link replacement |
| Human asks/reviews/responses | Spark ask/review/task flows, surfaced over Spark runtime protocol | Inbox projection and delivery tracking in `human_requests`, `human_responses`, `inbox_items`, `asks`, and `reviews`; Cockpit can record local user response delivery state | Runtime message receipt plus `human_requests(runtime_workspace_binding_id, runtime_request_id)` |
| Audit/event feed | Spark Cockpit server local audit | Append-oriented diagnostic log, not execution truth | Runtime message receipt prevents protocol replay from duplicating ingested message effects |

## Rules

1. Spark Cockpit must call Spark APIs for execution and durable Spark task/artifact
   mutation; it must not write `.spark/*.json` directly.
2. Projection ingestion must tolerate reconnect/replay. Runtime protocol messages
   are remembered in `runtime_message_receipts` by `(runtime_id, message_id,
   message_type)`. Replayed messages receive `server.ingest_ack` without
   applying projection writes again.
3. Snapshot and artifact projection functions remain idempotent even when called
   directly by tests or repair jobs: task graph snapshots upsert by runtime
   snapshot id and replace child rows; artifact projections upsert by artifact id
   and replace links.
4. Cockpit `projects` rows are routing/grouping records, not Spark task
   graph projects. They may launch Spark work and later store projected Spark
   refs in metadata, but Spark remains authoritative for executable tasks, runs,
   TODOs, and evidence artifacts.
5. Cockpit tables may denormalize Spark refs into JSON payloads or content refs for
   display, but those refs remain pointers back to Spark-owned state.
6. Cache tables such as `artifact_cache_blobs` may be evicted or rebuilt without
   changing Spark execution truth.

## Implementation hooks

- `apps/spark-daemon/src/spark/bridge.ts` emits Spark-backed runtime protocol
  envelopes with Spark refs in payload/content refs.
- `apps/spark-cockpit/src/lib/server/runtime-ws.ts` records runtime message receipts
  before acknowledging projection ingestion, and skips already-seen messages on
  reconnect replay.
- `apps/spark-cockpit/src/lib/server/projection-services.ts` keeps direct projection
  writes idempotent through upsert/delete-and-replace patterns.
- `packages/spark-db/src/migrations/0007_runtime_message_receipts.sql` adds the
  replay guard table used by the runtime WebSocket ingestion layer.

## Validation

The boundary is covered by:

- `apps/spark-cockpit/src/lib/server/projection-services.test.ts` for direct replay
  of task graph snapshots and artifact projections.
- `apps/spark-cockpit/src/lib/server/runtime-ws.test.ts` for reconnect replay of a
  runtime projection message by message id.
- `scripts/check-pi-boundaries.mjs` for forbidden dependency/import directions.
