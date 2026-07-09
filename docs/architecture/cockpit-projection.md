# Spark Cockpit projection store boundary

Spark Cockpit's SQLite database is a local web-cockpit projection/cache. It is not the
authoritative task, run, artifact, ask, or review store for Spark execution. Spark
`.spark/` stores and `@zendev-lab/spark-artifacts` remain execution source of truth;
Cockpit stores enough mirrored state to render the UI, route runtime protocol messages,
reconnect safely, and cache artifact previews.

Code constants live in `packages/spark-protocol/src/state-ownership.ts`.

## Source-of-truth matrix

| Area | Authoritative owner | Cockpit SQLite role |
| --- | --- | --- |
| Workspaces, local owner bindings, runtime registrations, auth sessions | server coordination / runtime registration flow | Authoritative local setup and routing state |
| Cockpit projects | Cockpit UI / product flow | Authoritative dashboard grouping and command-routing records; **not** Spark task graph projects |
| Workspace resources and profile inventory | Spark Cockpit workspace profile/import flow | Authoritative local setup/catalog state |
| Command queue and delivery attempts | server runtime protocol broker | Authoritative delivery bookkeeping; execution state remains Spark-owned after daemon ack/start |
| Spark tasks/TODOs/plans/runs | Spark task graph APIs and `.spark/projects.json` / run stores | Projection only: task graph snapshot tables |
| Invocations / role-run status | Spark runtime/role-run state | Projection only: mirrored invocation tables |
| Artifacts / evidence body | Spark artifact store (`@zendev-lab/spark-artifacts`) | Projection/cache metadata plus optional preview/body cache |
| Human asks/reviews/responses | Spark ask/review/task flows over runtime protocol | Inbox projection and delivery tracking |
| Audit/event feed | Cockpit UI local audit | Append-oriented diagnostic log, not execution truth |

## Rules

1. Spark Cockpit must call Spark APIs for execution and durable Spark task/artifact
   mutation; it must not write `.spark/*.json` directly.
2. Projection ingestion must tolerate reconnect/replay. Runtime protocol messages are
   remembered by `(runtime_id, message_id, message_type)`; replayed messages acknowledge
   without applying projection writes again.
3. Snapshot and artifact projection functions remain idempotent: task graph snapshots
   upsert by runtime snapshot id and replace child rows; artifact projections upsert by
   artifact id and replace links.
4. Cockpit `projects` rows are routing/grouping records, not Spark task graph projects.
   They may launch Spark work and later store projected Spark refs in metadata, but Spark
   remains authoritative for executable tasks, runs, TODOs, and evidence artifacts.
5. Cockpit tables may denormalize Spark refs into JSON payloads or content refs for
   display, but those refs remain pointers back to Spark-owned state.
6. Cache tables such as `artifact_cache_blobs` may be evicted or rebuilt without changing
   Spark execution truth.

## Implementation hooks

- `apps/spark-daemon/src/spark/bridge.ts` emits Spark-backed runtime protocol envelopes.
- `apps/spark-cockpit/src/lib/server/runtime-ws.ts` records runtime message receipts
  before acknowledging projection ingestion.
- `apps/spark-cockpit/src/lib/server/projection-services.ts` keeps direct projection
  writes idempotent through upsert/delete-and-replace patterns.
- `packages/spark-db` owns SQLite migrations and the projection schema.

Schema and migration details live in `packages/spark-db/src/migrations/`. Server
coordination APIs live in `packages/spark-server/`.
