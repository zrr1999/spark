# RFC: Spark Cockpit SvelteKit backend/server

Status: draft
Date: 2026-05-21

## Summary

Inside the merged Spark monorepo, Navia owns a SvelteKit web cockpit with TypeScript server routes and a separate `apps/spark-daemon` process. The server side is a lightweight communication/projection plane backed by SQLite. Spark daemon implementation is same-monorepo but remains isolated behind protocol/contracts and invokes Spark runtime primitives for execution.

Recommended first stack:

```text
SvelteKit + Node 26 + node:sqlite + Zod + Kysely + WebSocket/SSE integration as needed
```

This replaces the earlier Hono/PostgreSQL-first baseline. Hono/Fastify and PostgreSQL remain possible future extraction/hosted-team options, but v0.1 should optimize for local-first simplicity, a single SvelteKit app boundary, and low operational weight.

## Goals

- Define the SvelteKit server boundary for Navia.
- Keep this repo focused on frontend/server UI, the separate Spark daemon process, protocol/contracts, projections, lazy artifact cache/proxy, and tests.
- Keep server and Spark daemon implementation separated by process/protocol boundaries while preserving a first-class Spark daemon projection model.
- Establish API/schema/database/realtime defaults before implementation.
- Make contracts consumable by `apps/spark-daemon` and by any future external Spark daemon without importing server internals.
- Support the full v0.1 web surfaces: cockpit, evidence board, inbox, task graph projection, and run/status views.

## Non-goals

- Implement multi-provider Spark daemon abstraction beyond the Spark runtime bridge.
- Choose additional Spark daemon implementation languages.
- Define local workdir/checkout cleanup internals.
- Make browser-to-Spark daemon direct connection the default path.
- Implement a hosted/SaaS deployment plan beyond keeping future migration plausible.
- Replace future protocol or data-model RFCs.

## Repository layout

Recommended repo shape:

```text
spark/
├── apps/
│   └── spark-cockpit/              # @zendev-lab/spark-cockpit; SvelteKit frontend + server routes + custom Node entry
├── packages/
│   ├── spark-daemon/           # @zendev-lab/spark-daemon; Spark daemon service controlled by `spark daemon`
│   ├── navia-protocol/         # @zendev-lab/navia-protocol; Zod schemas, event envelopes, fixtures
│   ├── navia-db/               # @zendev-lab/navia-db; node:sqlite, Kysely adapter/dialect, migrations
│   ├── navia-domain/           # @zendev-lab/navia-domain; headless workspace/project/inbox/artifact services
│   ├── navia-system/           # @zendev-lab/navia-system; XDG paths, private dirs/files, Spark daemon state paths
│   └── navia-ui/               # @zendev-lab/navia-ui; shared Svelte primitives and design tokens
├── docs/navia/
├── pnpm-workspace.yaml
└── package.json
```

SvelteKit owns both UI routes and server/API routes initially. Do not create `apps/server` for v0.1; if Spark daemon WebSocket support needs a custom Node process, keep the entry in `apps/spark-cockpit/server/index.ts`. `apps/spark-daemon` is a separate process boundary, not a second web server.

`apps/spark-cockpit` must not import `@zendev-lab/spark-daemon` internals. Server-Spark daemon interaction goes through protocol schemas, API contracts, fixtures, and WebSocket/HTTP surfaces.

## Architecture

```text
apps/spark-cockpit (SvelteKit UI + server routes)
  |
  +-> SQLite communication/projection state
  +-> append-only events/audit
  +-> artifact metadata + lazy cache/proxy pointers
  +-> Spark daemon protocol endpoints/channels
```

### Frontend responsibilities

- Workspace/project cockpit.
- Web ask inbox UI.
- Evidence/artifact board.
- Full task graph projection and run projection views.
- Connection health/diagnostics views, with Spark daemon identity downplayed.
- Client-side transient state only: filters, selections, expansion, drafts.

Frontend server data should live in SvelteKit load/query/subscription state, not duplicated in ad-hoc UI stores.

### SvelteKit server responsibilities

- Communication/projection state owner.
- Auth/session/membership boundary.
- Spark daemon registration, tokens, sessions, and workspace bindings.
- Command routing/delivery/ack/reject records.
- Workspace/project/resource/agent-spec records and projections.
- Spark-daemon-owned task graph projections/snapshots.
- Web ask inbox, asks, reviews, reminders.
- Artifact metadata/projections and lazy cache/proxy pointers.
- Append-only event/audit log.
- Spark daemon heartbeat/liveness/diagnostics.
- Spark daemon log/event/artifact projection ingestion.
- Spark daemon protocol docs and fixtures.

### Spark daemon responsibilities

- Authentication/config UX for the Spark daemon.
- Managing multiple workspace bindings.
- Spark runtime bridge invocation for task mutation/execution semantics.
- Projection delivery for Spark-owned task graph/run state.
- Local orchestration/scheduling decisions before invoking Spark.
- Local workdirs/checkouts/cache.
- Local logs/checkpoints/canonical artifacts.
- Agent ask/review tool bridging and blocking waits.
- Spark daemon-side cancellation, cleanup, and safety policy.

## User-to-Spark daemon connectivity

Default v0.1 rule: **browser/user actions go through Navia's SvelteKit server, not directly to the Spark daemon**.

Rationale:

- keeps auth and authorization centralized;
- preserves append-only audit;
- keeps inbox response delivery consistent;
- keeps artifact lazy cache/proxy coherent;
- avoids split-brain projections between browser and server;
- allows remote access later without changing the product interaction model.

Design placeholder: reserve room for a future direct local diagnostic/pairing channel for setup or emergency troubleshooting. It is **not implemented in v0.1** and must stay outside normal product traffic. If designed later, it must be explicit, privileged, time-limited, visibly audited, and unable to mutate workspace/project state without going through the server-mediated authorization/audit path.

## Technology choices

### Runtime: Node.js 26 baseline

Use Node.js 26 as the v0.1 runtime baseline for SvelteKit.

Rationale:

- Node 26 provides the native `node:sqlite` module, avoiding third-party native SQLite addon packaging for the default path.
- Stable production/local deployment story.
- Best compatibility with pnpm, Vite, Vitest, SvelteKit, WebSocket/SSE, OpenAPI generation, and background jobs.
- Avoids premature Bun/Deno operational questions.

If Node 26 is not available in a target deployment, hold the affected release or temporarily pin an implementation branch rather than silently switching database drivers. Bun/Deno can be revisited only if a concrete deployment or packaging reason appears.

### Web/server framework: SvelteKit first

Default to SvelteKit for both frontend and server/API routes.

Rationale:

- User preference: backend can be SvelteKit directly.
- One app boundary is simpler than separate web + Hono server for v0.1.
- File-based routes, server load functions, form actions, and API routes fit the dashboard/inbox workflow.
- Keeps Svelte UI and backend projections close while data contracts remain explicit.
- Still allows extraction to Hono/Fastify later if needed.

Use Hono/Fastify later only if a separate API service becomes clearly valuable.

### API schema: Zod + generated docs

Use Zod schemas at TypeScript/API/protocol boundaries.

Rules:

- API request/response/event payloads need runtime validation.
- External protocol must be consumable without importing TS internals.
- JSON fixtures are part of the external contract.
- OpenAPI can be generated for HTTP endpoints where useful, but SvelteKit route handlers remain the initial implementation surface.
- TS types may be generated from schemas, but TS-only types are not external contracts.

Recommended package:

```text
packages/protocol/
├── src/
│   ├── schemas/
│   ├── events/
│   ├── fixtures/
│   └── openapi.ts             # optional/generated when useful
└── package.json
```

### Database: SQLite first

Use SQLite for v0.1 product state.

Rationale:

- Lightweight local-first operational model.
- No separate database service for initial development/use.
- Workspace/project/inbox/artifact/projection data are relational enough for SQLite.
- WAL mode is sufficient for a single-node SvelteKit server.
- Easy export/backup story.
- Future PostgreSQL migration remains possible if hosted/team mode requires it.

SQLite driver decision:

- **Use native `node:sqlite` on Node 26** as the default v0.1 driver. This keeps the local-first stack dependency-light and avoids extra native addon packaging.
- Keep SQL usage conservative and explicit so the data layer can move to PostgreSQL later if hosted/team mode requires it.
- Do **not** choose `libsql` unless remote/sync SQLite becomes a product requirement.
- Do **not** choose `better-sqlite3` by default; keep it only as a fallback if `node:sqlite` proves missing a required capability after implementation testing.

### Query layer: Kysely first

Default to Kysely with a thin `node:sqlite` dialect/adapter.

Rationale:

- SQL-shaped and readable.
- Type-safe queries without hiding relational structure.
- Good fit for explicit migrations and reviewable data model changes.
- Keeps a future PostgreSQL migration more plausible than a heavily SQLite-specific abstraction.
- Keeps raw driver coupling small if Kysely's built-in ecosystem lags the native Node driver.

Choose Drizzle instead if schema-as-code and generated migrations become more valuable than SQL-shaped query readability.

Avoid Prisma initially unless product velocity strongly outweighs SQL control.

### Migrations

Use explicit SQL migrations checked into the repo.

Recommended shape:

```text
packages/db/src/
├── client.ts
├── dialect.ts
├── migrations/
│   ├── 0001_initial.sql
│   └── ...
└── migrate.ts
```

Migration Spark daemon can be a small TypeScript script. Keep migrations reviewable and reversible where reasonable.

### Artifact cache layout and eviction

Artifact content cache is lazy and local to the Navia server XDG cache area.

Recommended v0.1 layout:

```text
${XDG_DATA_HOME:-~/.local/share}/navia/server/
└── navia.sqlite

${XDG_CACHE_HOME:-~/.cache}/navia/server/artifacts/
├── blobs/
│   └── sha256/<first2>/<hash>
├── previews/
│   └── <artifact-id>/<variant>.<ext>
└── tmp/
```

Rules:

- `artifacts` table stores metadata/provenance and canonical external content refs.
- `artifact_cache_blobs` stores cache entries: `artifactRef`, `hash`, `sizeBytes`, `mime`, `cachePath`, `sourceRef`, `fetchedAt`, `lastAccessedAt`, `expiresAt?`, `pinReason?`, `state`.
- Cache paths are content-addressed where possible (`sha256/...`) to deduplicate repeated artifact content.
- Preview/rendered derivatives live separately from original blobs and can be evicted first.
- Cache fill happens on first frontend view/export, explicit prefetch, or share/export operation. Artifact production only records metadata unless the content is already server-local.
- Cache eviction must never delete canonical external/Spark daemon artifacts; it only removes Navia's local cached copy or preview.

Recommended v0.1 eviction policy:

- Defaults: soft cap `5 GiB` per workspace; hard cap `10 GiB`; unpinned cache TTL `30 days` since `lastAccessedAt`; preview TTL `7 days`.
- Evict previews before original blobs.
- Evict unpinned least-recently-used entries first when above soft cap.
- Refuse new cache writes or require explicit user cleanup when above hard cap and no evictable entries remain.
- Pin cache entries needed by current conclusion, accepted review, explicit export package, or user pin.
- Keep cache cleanup as an in-process scheduled job in v0.1; expose a diagnostics page/CLI to show cache usage and manually clear unpinned entries.

### Realtime: SSE first for frontend, WebSocket where bidirectional is required

Suggested split:

| Channel                          | Recommended transport               | Reason                                           |
| -------------------------------- | ----------------------------------- | ------------------------------------------------ |
| Spark daemon control/session           | WebSocket                           | bidirectional messages and lower-latency control |
| Frontend project/activity stream | SSE first                           | simpler for server-to-browser updates            |
| One-shot CRUD/query              | SvelteKit server routes / HTTP JSON | easier caching, testing, and generated docs      |
| Local UI forms                   | SvelteKit actions where appropriate | simple for inbox answers/settings                |

Use WebSocket for frontend only if the UI needs true browser-to-server bidirectional streaming beyond normal actions/HTTP.

## Core domains

Initial SvelteKit server modules under `apps/spark-cockpit/src/lib/server/`:

```text
src/lib/server/
├── config/
├── db/
│   ├── client.ts
│   ├── migrations/
│   └── schema-types.ts
├── workspaces/
├── projects/
├── resources/
├── agent-specs/
├── task-graphs/
├── inbox/
├── reviews/
├── artifacts/
├── events/
├── runtime-connections/
├── invocations/
└── realtime/
```

SvelteKit routes under `apps/spark-cockpit/src/routes/` should call these server modules rather than embedding domain logic directly in route files.

Domain ownership:

| Domain                | Owns                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `workspaces`          | workspace identity, settings, members                                       |
| `projects`            | project lifecycle and project summary                                       |
| `resources`           | workspace resources plus project resource attachments                       |
| `agent-specs`         | reusable workspace agent specs and policies                                 |
| `task-graphs`         | Spark-daemon-owned task graph projections/snapshots for cockpit/status            |
| `inbox`               | web ask inbox items and reminders                                           |
| `reviews`             | review gates and outcomes                                                   |
| `artifacts`           | artifact metadata, provenance, lazy content cache pointers                  |
| `events`              | append-only event log and audit queries                                     |
| `runtime-connections` | communication identity, sessions, workspace bindings, liveness, diagnostics |
| `invocations`         | Spark daemon-reported invocation/run projections and event mirrors                |
| `realtime`            | SSE/WebSocket fanout                                                        |

## Workspace/project boundary

Workspace can exist with no project.

May exist before any project:

- resources/repo registry;
- agent specs;
- workspace artifacts;
- settings/trust policy;
- connection diagnostics/projections.

Project-only or project-attached concepts:

- project cockpit;
- inbox items;
- task graph projections;
- invocation/run projections;
- asks/reviews;
- project artifacts/evidence;
- current conclusion.

Freeform/user-submitted **request intake** means a user can submit an unstructured idea/brief into Navia before a project exists and later triage it into a project. This is deferred for v0.1 unless a focused intake RFC is created.

## Protocol surface

This repo owns protocol and server communication endpoints; `apps/spark-cockpit` must not import Spark daemon internals.

Initial protocol-facing concepts:

- `RuntimeRegistration`
- `RuntimeSession`
- `RuntimeWorkspaceBinding`
- `WorkspaceSnapshot`
- `TaskGraphSnapshot`
- `RuntimeHeartbeat`
- `ServerCommand`
- `RuntimeCommandAck` / `RuntimeCommandReject`
- `HumanRequestCreated`
- `HumanResponseDeliver`
- `HumanResponseAck`
- `InvocationStarted`
- `InvocationLogChunk`
- `InvocationArtifactProduced`
- `InvocationCompleted`
- `RuntimeReconcileRequest` / `RuntimeReconcileReport`

Initial protocol endpoints/channels:

```text
POST /api/v1/runtime/runtimes/register
GET  /api/v1/runtime/runtimes/:runtimeId/ws      # required WS control/session channel
POST /api/v1/runtime/workspaces                  # choose owning workspace binding
GET  /api/v1/runtime/commands/:commandId/payload
POST /api/v1/runtime/artifacts/:artifactId/cache-requests
GET  /api/v1/runtime/artifacts/:artifactId/content
```

Core WebSocket messages:

```text
runtime.hello
server.hello_ack
runtime.heartbeat
workspace.snapshot
task_graph.snapshot
server.command
runtime.command.ack
runtime.command.reject
human.request.created
human.response.deliver
human.response.ack
invocation.started/status/log/artifact/completed
runtime.reconcile.request
runtime.reconcile.report
```

Protocol requirements:

- All payloads validated with Zod.
- HTTP endpoints documented with generated OpenAPI where useful.
- WebSocket message envelopes documented with JSON fixtures.
- Re-registration should converge rather than creating duplicate active connections.
- Workspace creation should bind the server-visible workspace to exactly one owning workspace binding in v0.1.
- Human ask/review requests should become web inbox items; server/frontend collect responses and deliver them back through the owning binding.
- Server marks connection/workspace bindings offline/degraded after heartbeat expiry, but does not declare Spark-owned invocations failed solely from connection loss.
- Frontend should remain workspace/project-first and downplay Spark daemon as connection diagnostics rather than primary product navigation.

## Data model sketch

This RFC does not finalize tables, but the SvelteKit server should expect at least:

```text
workspaces
projects
resources
project_resources
agent_specs
task_graph_snapshots
task_graph_clusters
task_graph_tasks
task_graph_dependencies
inbox_items
asks
reviews
artifacts
artifact_cache_blobs
events
runtime_connections
runtime_sessions
runtime_workspace_bindings
workspace_owner_bindings
commands
command_deliveries
human_requests
human_responses
mirrored_invocations
invocation_events
```

Important constraints:

- Communication/projection state lives in SQLite.
- Each server-visible workspace has exactly one active owning Spark daemon workspace binding in v0.1.
- Workspace resources, agent specs, and workspace artifacts may exist without a project.
- Task graph tables are projections/snapshots of Spark-owned truth, not server-owned task execution truth.
- Human requests/responses live in server DB as delivery/inbox records, but agent-facing tool contracts remain Spark-daemon-owned.
- Canonical Spark daemon-produced artifact content remains external; server artifact metadata/projections and lazy cache pointers live in DB.
- Events are append-only except explicit migration/repair operations.
- Heartbeat/session state is mutable current connection state; heartbeat events may also be appended for audit at lower frequency.
- Mirrored invocation history is durable evidence/projection; Spark-daemon-owned retries create/report new invocations rather than rewriting old terminal attempts.

## Auth and trust boundary

Early implementation can keep auth minimal, but the boundary should be explicit:

- Frontend users authenticate to the SvelteKit app.
- Spark daemon clients authenticate with tokens or device credentials.
- Tokens are scoped to Spark daemon identity plus workspace grants/capability policy.
- Server decides whether a command may be routed to the workspace's owning binding.
- Server must not route workspace commands or human responses to non-owning bindings in v0.1.
- Spark daemon bridge decides whether/how the routed command executes through Spark runtime APIs and enforces execution safety/provenance.
- Browser-to-Spark daemon direct connection is not a default path; v0.1 only keeps a design placeholder for a future explicit diagnostic/pairing channel.

Do not rely on Spark daemon self-reporting for product authorization decisions.

## Events and observability

Use structured JSON logs and append-only communication/product projection events.

Minimum event categories:

- workspace/project created/updated;
- workspace owner binding selected;
- task graph snapshot received;
- inbox item created/resolved/archived;
- human request created;
- human response delivered/acknowledged;
- ask answered;
- review accepted/rejected;
- artifact metadata created;
- artifact content lazily cached/proxied;
- Spark daemon registered/offline/draining;
- workspace binding reported/degraded/unavailable;
- command routed/acked/rejected/cancelled;
- invocation mirrored as started/logged/completed/failed/cancelled/lost.

Operational observability can start simple:

- SvelteKit request logs;
- Spark daemon connection logs;
- invocation lifecycle logs;
- SQLite migration logs;
- basic metrics hooks left as extension points.

## Background work

Allowed in-process at first:

- pending human decision reminders;
- undelivered human response retry/redelivery;
- stale connection sweep;
- stale mirrored invocation/reconciliation detection;
- lazy artifact cache cleanup scheduling metadata: LRU/TTL/size-cap sweeps for unpinned cache entries.

Move to a separate worker process/package when:

- jobs must survive server restarts with strict guarantees;
- queue throughput matters;
- hosted deployment needs horizontal scaling;
- background execution starts blocking request latency.

## Testing strategy

Minimum tests before implementation is considered coherent:

- Zod schema validation for public API/protocol payloads;
- generated docs/fixtures do not drift;
- SQLite migrations apply from empty DB;
- workspace can exist without projects and can contain resources, agent specs, and workspace artifacts;
- workspace creation stores exactly one owning binding;
- heartbeat marks connection online and stale sweep marks offline;
- command routing/cancellation delivery is auditable and targets only the owning binding;
- human request appears in web inbox;
- human response delivery is idempotent and acknowledged;
- task graph snapshots update cockpit projections without making server own execution truth;
- terminal invocation mirror is idempotent;
- inbox human decisions do not timeout automatically;
- artifact provenance is required for produced artifacts;
- artifact content cache is lazy and triggered by view/export;
- cache writes land under the XDG server artifact cache and eviction respects TTL/LRU/size caps without deleting canonical Spark daemon artifacts;
- frontend query/load fixtures match API schemas.

## Remaining deferred questions

These are not blockers for v0.1 development:

1. Hosted/team auth strategy beyond the selected local-first owner setup.
2. User-submitted request intake lifecycle, if/when it becomes in scope.
3. Authorization/audit UX for the diagnostic/pairing placeholder, if/when it becomes an implemented flow.

Selected for v0.1 development:

- Local-first owner setup plus HttpOnly browser sessions.
- Spark daemon enrollment token exchanged for hashed Spark daemon credential.
- Protocol version `navia.runtime.v1alpha1`, failing loudly on unsupported pre-v1 versions.
- Request intake and direct diagnostic/pairing implementation are deferred.

## Decision summary

Current recommended defaults:

```text
App/server framework = SvelteKit
Runtime = Node.js 26
SQLite driver = native node:sqlite
Schema/contracts = Zod + JSON fixtures/OpenAPI where useful
Database = SQLite
Query layer = Kysely with thin node:sqlite adapter/dialect
Migrations = explicit SQL files + small TS migration runner
Frontend realtime = SSE first
Spark daemon control = WebSocket
Artifact content cache = lazy on first frontend view/export under XDG server cache
Artifact cache eviction = metadata-driven LRU/TTL/size cap, never deletes canonical Spark daemon artifacts
Browser-to-Spark daemon direct connection = no product path by default; diagnostic/pairing placeholder only
Task graph = Spark-owned truth, Navia projection/snapshot UI
Repo scope = SvelteKit frontend/server + separate Spark-bridged Spark daemon process + protocol/contracts + SQLite projections + UI
Implementation details = see implementation-options-rfc.md and data-model-rfc.md
```
