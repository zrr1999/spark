# Navia implementation plan

## Scope

A staged plan for turning the research direction into concrete Navia work.

This plan originated in the standalone Navia workspace. In the merged Spark monorepo it is retained as delivery history and updated where needed for the current product line: Navia is Spark's local web cockpit/projection surface, not a separate execution authority.

## Architecture conclusion

Adopt a lightweight SvelteKit cockpit app plus a separate Spark daemon process inside the Spark TypeScript monorepo:

```text
Spark repo: apps/spark-cockpit SvelteKit frontend + TypeScript server routes/API
                                              |
                                              +-> communication/projection plane:
                                                  auth, sessions, routing,
                                                  SQLite projections, events/audit,
                                                  web fanout, lazy artifact cache/proxy

apps/spark-daemon Spark daemon <-------> Spark Cockpit SvelteKit server/API
        |
        +-> Spark runtime bridge:
            task graph/run/artifact truth in Spark stores,
            workspace registration, local protocol session,
            logs/checkpoints/projections, safety policy
```

### Responsibilities

| Part                    | Owns                                                                                                                                                                                                              | Does not own                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SvelteKit frontend      | Workspace/project dashboard UI, web ask inbox UI, evidence board, task graph projection/run views, connection diagnostics, client-side transient state.                                                           | Direct local checkout management, Spark daemon as primary product navigation, direct browser-to-Spark daemon default traffic.                          |
| SvelteKit server routes | Communication/projection plane: APIs, auth, sessions/tokens, workspace bindings, command/human-response routing and delivery records, SQLite projections, event/audit log, web fanout, lazy artifact cache/proxy. | Provider CLI execution strategy, daemon-local scheduling, workdir/resource locking, canonical local artifacts, task graph execution truth. |
| `apps/spark-daemon` process | Workspace registration, runtime protocol session, Spark runtime bridge invocation, local policy, command ack/reject/execution projection, logs/checkpoints/projection delivery.                           | Web UX decisions, direct server internals, browser/product traffic, direct writes to Spark `.spark` stores outside Spark APIs.             |

This supersedes the earlier pure local filesystem-watch/narrow-backend-only plan, the earlier thin-Spark daemon/server-scheduler framing, and the earlier Hono/PostgreSQL-first server baseline. Elm-style architecture remains useful inside the frontend, but UI should be workspace/project-first while Spark daemon details are mostly connection/provenance diagnostics.

Default user traffic is server-mediated: browser/user actions go through Navia's SvelteKit server. Direct user/browser-to-Spark daemon connection is not a v0.1 product path because it would bypass auth, audit, inbox response delivery, artifact cache, and projection consistency. Keep only a design placeholder for a future direct diagnostic/pairing channel; it must be explicit, privileged, time-limited, visibly audited, and unable to mutate product state without returning to the server-mediated path.

## Infrastructure baseline

Adopt standards at least as strong as Loom, sixbones.dev, and the useful parts of Multica:

- pnpm workspace with pinned `packageManager`.
- SvelteKit app under `apps/spark-cockpit` for frontend + server routes.
- Vite+ (`vp`) where practical for format/lint/check entrypoints.
- `prek` hooks for recurring local validation.
- Strict TypeScript and Zod at TypeScript/API/protocol boundaries.
- SQLite for v0.1 communication/projection state.
- Kysely with a thin native `node:sqlite` adapter/dialect for SQL-shaped type-safe queries.
- Explicit SQL migrations checked into the repo.
- SSE first for frontend project/activity streams; WebSocket where bidirectional protocol channels are required.
- Spark daemon implementation lives in this monorepo under `apps/spark-daemon`, but remains a separate process connected through the Spark daemon/server protocol. It is controlled through `spark daemon` and routes task execution through Spark runtime primitives, not a direct Pi SDK execution authority.
- Shared XDG path resolution lives in `packages/system`. Defaults are `${XDG_DATA_HOME:-~/.local/share}/navia/server` and `${XDG_DATA_HOME:-~/.local/share}/spark/daemon`, `${XDG_CACHE_HOME:-~/.cache}/navia/server` and `${XDG_CACHE_HOME:-~/.cache}/spark/daemon`, `${XDG_STATE_HOME:-~/.local/state}/navia/server` and `${XDG_STATE_HOME:-~/.local/state}/spark/daemon`, and `${XDG_CONFIG_HOME:-~/.config}/navia/server.toml` and `${XDG_CONFIG_HOME:-~/.config}/spark/daemon.toml`.
- UI starts lightweight: custom Navia components plus direct Bits UI headless primitives where needed; use lucide-style icons/minimal helpers as needed, but do not adopt a shadcn-svelte generated component tree.
- No Astro.

### SvelteKit server stack recommendation

Use `docs/rfcs/backend-server-rfc.md`, `docs/rfcs/implementation-options-rfc.md`, and `docs/rfcs/data-model-rfc.md` for exact library/data choices. Current recommendation:

- **App/server framework:** SvelteKit first. Use server routes, load functions, form actions, and API endpoints directly.
- **Runtime:** Node.js 26 first so Navia can use native `node:sqlite`. Keep Bun/Deno out of the baseline until deployment/ops needs are explicit.
- **Schema/API contracts:** Zod-first schemas with JSON fixtures and OpenAPI generation where useful. Do not rely on TS-only types across repo boundaries.
- **Database:** SQLite first for lightweight local-first state.
- **SQLite driver:** use native `node:sqlite` on Node 26. Keep `better-sqlite3` only as a fallback if implementation testing finds a blocking native-driver gap; use `libsql` only if remote/sync SQLite becomes a product requirement.
- **Query layer:** prefer Kysely with a thin `node:sqlite` adapter/dialect for SQL-shaped type-safe queries and future PostgreSQL portability; choose Drizzle only if schema-as-code becomes more valuable.
- **Realtime:** SSE first for frontend event streams; WebSocket for Spark daemon control/session.
- **Jobs/scheduling:** start in-process for reminders/sweeps/lazy-cache cleanup only if safe; move to a separate worker when reliability or scale requires it. Lazy artifact cache cleanup should evict previews first, then unpinned LRU/TTL blobs over the soft cap, and never delete canonical external artifacts.
- **Repo layout:** `apps/spark-cockpit` is the SvelteKit app (`@zendev-lab/spark-cockpit`) and `apps/spark-daemon` is the Spark daemon service package (`@zendev-lab/spark-daemon`). Use high-cohesion packages `@zendev-lab/navia-protocol`, `@zendev-lab/navia-db`, `@zendev-lab/navia-domain`, `@zendev-lab/navia-system`, and `@zendev-lab/navia-ui`.

## Stage 0 — Architecture/RFC reset

Goal: align docs around SvelteKit + SQLite + projections + same-monorepo Spark daemon process + Spark daemon/server protocol.

Docs to add/update before implementation:

- `backend-server-rfc.md` — done.
- `spark-daemon-protocol-rfc.md` — done for protocol boundary; protocol code keeps `runtime` wire terminology, while UI and operator-facing code use `Spark daemon`.
- `implementation-options-rfc.md` — done; freezes concrete implementation defaults.
- `data-model-rfc.md` — done; freezes first SQLite migration shape.
- `frontend-rfc.md` — can be written after scaffold/app shell starts.
- `web-ask-inbox-rfc.md` — can be extracted from protocol/backend docs during inbox implementation.
- `artifact-provenance-rfc.md` — can be extracted from backend/data-model docs during artifact implementation.

Success criteria:

- Responsibilities between SvelteKit UI/server and Spark daemon process are explicit.
- SvelteKit server routes are the communication/projection owner, not the owner of Spark daemon core capabilities.
- Spark daemon implementation is in `apps/spark-daemon`, but task graph/execution truth stays Spark-side and communicates with the Navia server through protocol projections only.
- Navia keeps its own vocabulary: workspace/project, task graph projections, web ask inbox, artifacts, reviews, and Spark daemon connections.
- Workspace-level resources, agent specs, and workspace artifacts are allowed before any project.
- Freeform/user-submitted request intake is defined as pre-project idea/brief triage and deferred unless a focused RFC is created.
- pi-spark remains adapter-only unless explicitly scoped.
- Implementation options are frozen enough to start scaffolding: pnpm monorepo, Node 26, SvelteKit adapter-node, native `node:sqlite`, Kysely adapter, Zod protocol package, local owner setup, Spark daemon enrollment token flow, and WS Spark daemon control.

## Development Slice 0 — Scaffold and protocol/data spine

Status: scaffold started and currently green for the implemented subset.

Goal: create the smallest runnable Navia codebase that proves tooling, protocol schemas, SQLite migrations, local setup auth, and Spark daemon registration/heartbeat can work together.

Tasks:

1. Create root `package.json`, `pnpm-workspace.yaml`, `.node-version`, `prek.toml`, and initial check/test scripts under `navia/`. — done.
2. Create `packages/protocol` (`@zendev-lab/navia-protocol`) with Zod schemas for refs, error envelope, runtime envelope, registration, hello, heartbeat, workspace binding snapshot, and fixtures. — done for registration/hello/heartbeat baseline.
3. Create `packages/db` (`@zendev-lab/navia-db`) with native `node:sqlite` client, Kysely adapter/dialect shell, pragmas, migration runner, and `0001_initial.sql` based on `data-model-rfc.md`. — done for initial schema subset plus repo-owned `NodeSqliteDialect`.
4. Create `packages/domain` (`@zendev-lab/navia-domain`) and `packages/ui` (`@zendev-lab/navia-ui`) as thin high-cohesion boundaries for services and shared Svelte primitives. — done as minimal packages.
5. Create `apps/spark-cockpit` (`@zendev-lab/spark-cockpit`) SvelteKit app with `@sveltejs/adapter-node`, strict TypeScript, Svelte check, and a custom Node server placeholder for Spark daemon WebSocket attachment. — done; WS placeholder replaced by hello/heartbeat handler.
6. Implement local owner setup/session tables and minimal setup route. — done for owner bootstrap and session cookie creation.
7. Implement Spark daemon enrollment/register endpoint and hashed Spark daemon token storage under `/api/v1/runtime/*`. — done for registration endpoint.
8. Implement Spark daemon WebSocket hello/heartbeat with a protocol test client/fixture. — done with fake WS unit test; full real client smoke still pending.
9. Implement workspace overview page backed by SQLite, even if mostly empty. — done.

Acceptance checks:

- `pnpm install` works with the pinned package manager. — done.
- `pnpm check` validates TypeScript/Svelte/protocol fixtures. — green.
- `pnpm test` runs protocol schema tests and migration-from-empty tests. — green; includes Kysely dialect and Spark daemon WS handler tests.
- Server starts locally, creates the XDG server SQLite database, applies migrations, and can show an empty workspace overview. — scaffold implemented; manual smoke remains useful.
- A Spark daemon smoke client can register, open WS, send hello/heartbeat, and update connection state. — done via `pnpm smoke:spark-daemon`; it also sends representative inbox/task/invocation/artifact projections and checks web/API paths.

Do not include real provider execution, direct browser-to-Spark daemon pairing, full graph rendering, or hosted/team auth in this slice.

## Stage 1 — SvelteKit + SQLite communication/projection model

Goal: define SvelteKit-server-owned communication state and frontend projections.

Core entities:

- Workspace
- Project
- Workspace Resource / ProjectResource / RepoResource
- AgentSpec
- RuntimeConnection
- RuntimeSession
- RuntimeWorkspaceBinding
- WorkspaceSnapshot
- ServerCommand / CommandDelivery
- TaskGraphSnapshot / ClusterProjection / TaskProjection / DependencyProjection
- Invocation/Run projection
- WebAsk / InboxItem
- Review
- ArtifactProjection / ArtifactCacheBlob
- Communication/Event audit record

Behavior:

- Workspace is the primary product/UI boundary and may exist with zero projects.
- Resources, agent specs, and workspace artifacts may exist before projects.
- Project is the execution/collaboration container.
- Spark daemon processes register once and may report multiple workspace bindings.
- Workspace creation selects exactly one owning Spark daemon workspace binding in v0.1.
- Server routes commands/human responses to the workspace's owning binding and records delivery/ack/reject state.
- Spark daemon owns execution feasibility, task graph truth, local orchestration, agent ask/review tool waits, and invocation lifecycle truth; server mirrors snapshots/events for frontend queries and subscriptions.
- Artifact content cache is lazy: store metadata/projection first, then fetch/cache/proxy content on first frontend view/export into the XDG server artifact cache.

Tests:

- Workspace/project CRUD and selection, including workspace with no projects.
- Workspace resources, agent specs, and workspace artifacts exist before projects.
- SQLite migrations apply cleanly from empty DB.
- Spark daemon registration/liveness state.
- Workspace creation binds to exactly one owning Spark daemon binding.
- Task graph snapshot/projection ingestion and dependency display rules.
- Artifact provenance validation and lazy cache behavior.
- Inbox item lifecycle and indefinite pending decisions.

## Stage 2 — Full SvelteKit frontend application shell

Goal: implement the full dashboard surfaces against SvelteKit server APIs/events rather than a narrow placeholder slice.

Pages:

- Workspace overview
- Projects
- Project cockpit
- Web ask inbox
- Evidence/artifacts
- Task graph / run status
- Connections/diagnostics (secondary; not primary Spark daemon navigation)
- Agent specs
- Resources
- Settings

State/data rules:

- Server data lives in SvelteKit load/query/subscription state.
- Local UI state only stores filters, selected rows, expansion, drafts, layout.
- Elm-style model/update/view can organize each page/module.
- Do not duplicate server data into ad-hoc UI stores.
- Spark daemon identity is shown for diagnostics/provenance, not as the primary navigation object.

Tests:

- Workspace/project switching does not show stale data.
- Workspace can show resources/specs/artifacts before any project exists.
- Web ask inbox updates after answer/cancel/archive.
- Task graph projection updates after snapshot events.
- Workspace connection health updates from backend events.
- Evidence board renders artifact provenance and triggers lazy cache on view/export.

## Stage 3 — Spark daemon protocol boundary

Goal: define the communication protocol used by the deployable `apps/spark-daemon` process while keeping server and Spark daemon implementation separated by process/protocol boundaries.

This Navia repo owns:

- Spark daemon registration API;
- required WebSocket control/session channel;
- Spark daemon workspace binding schema;
- workspace snapshot/projection schema;
- task graph snapshot/projection schema;
- heartbeat/liveness model for connection health;
- server command routing/delivery/ack/reject API;
- human request and response delivery API;
- cancellation command routing;
- log/event/artifact projection ingestion;
- lazy artifact cache/proxy request API backed by the XDG server artifact cache;
- connection diagnostics UI.

`apps/spark-daemon` owns:

- authentication/config UX;
- daemon lifecycle, packaging, updates, service install, status, and logs;
- the Spark runtime bridge for task execution;
- managing multiple workspace bindings;
- owning each created workspace through one binding in v0.1;
- local workdir/checkout handling;
- command execution/orchestration through Spark APIs;
- agent `ask_user`/review tool bridging and blocking waits;
- local logs/checkpoints/projection delivery;
- Spark daemon-side safety policy.

Spark task graph, run, and artifact stores remain the canonical execution truth behind that bridge.

Tests:

- Spark daemon registration and duplicate re-registration converge.
- A Spark daemon can report multiple workspace bindings.
- Workspace creation binds to exactly one owning Spark daemon binding.
- Heartbeat/liveness flips connection state online/offline correctly.
- Command routing/ack/reject lifecycle is auditable.
- Human requests appear in web inbox and responses are delivered back through the owning binding.
- Spark daemon restart reconciliation does not strand active invocations or pending human responses silently.
- Task graph snapshots reconcile without server claiming execution truth.
- Protocol fixtures remain the only server-Spark daemon wire contract; `apps/spark-cockpit` must not import `@zendev-lab/spark-daemon`.

## Stage 4 — Web ask inbox

Goal: implement Inbox as the web human-interaction surface.

Behavior:

- Spark daemon-originated asks/decisions/approvals/reviews appear as inbox items.
- The agent layer only sees tools such as `ask_user`; Spark daemon converts the blocking tool call into a human request protocol message.
- Server/frontend collect the answer and deliver a human response back through the owning binding.
- Spark daemon returns the response to the blocked tool call so the agent can continue.
- Answers persist to ask/review artifacts/projections and update inbox state.
- Pending decisions wait indefinitely.
- Recurring reminders/visible badges surface stale pending decisions.
- No automatic timeout/approval/rejection/cancellation from elapsed time.
- Future Pi plugin/integration can bridge Pi ask and Spark Cockpit inbox.
- User-submitted pre-project request intake is deferred; if added later, it should be a separate intake flow, not confused with Spark-daemon-originated asks/reviews.

Tests:

- Spark daemon-created ask appears in web inbox.
- Ask answer is delivered to the owning binding and acknowledged.
- Ask answer updates artifact/projection + inbox state.
- Review acceptance/rejection remains auditable.
- Reminder scheduling does not auto-resolve items.
- Inbox is not an execution queue.

## Stage 5 — Artifact provenance + lazy cache

Goal: make evidence first-class without eagerly copying Spark daemon content.

Rules:

- Artifacts are scoped provenance objects: workspace/project scope, refs, links, provenance, and content/blob pointers.
- Artifact projections/metadata live in SQLite for web UX.
- Canonical Spark daemon-produced artifact content remains external.
- Server may cache/proxy content lazily on first frontend view/export.
- Artifacts can be produced by humans, asks, reviews, backend imports, or Spark daemon projections.
- Workspace artifacts can exist without projects.

Tests:

- Artifact provenance is required for new artifacts.
- Evidence board can query by workspace/project/task/invocation/review/kind.
- Current conclusion can link to supporting artifacts.
- Workspace artifacts render before any project exists.
- First view/export triggers lazy cache/proxy; subsequent views use cached content when valid.
- Cache eviction respects preview-first, unpinned LRU/TTL, and workspace size caps without deleting canonical external artifacts.

## Stage 6 — Task graph projections

Goal: render the full task graph in Navia while keeping task graph truth Spark-runtime-owned.

Rules:

- Clusters/tasks/dependencies/runs form a DAG-style projection for planning/status UI.
- Spark task/run stores own task graph mutation and execution truth; the Spark daemon bridge reports projections.
- Navia stores snapshots/projections with provenance/version timestamps.
- Tasks may produce server commands routed to an owning Spark daemon workspace binding; the Spark bridge decides execution feasibility through Spark runtime APIs and reports invocation/run lifecycle.
- Task graph is cockpit/status/evidence projection, not local process management and not server-owned task claiming.

Tests:

- Snapshot ingestion validates references/dependencies.
- Ready/blocked/running/completed status displays correctly from projection.
- Invocation linkage is preserved.
- Projection reconciliation does not rewrite terminal invocation evidence incorrectly.
- Import adapters do not make pi-spark storage canonical.

## Stage 7 — CLI/control surfaces

Goal: provide automation-friendly control similar to Multica while keeping normal user traffic server-mediated.

Surfaces in this repo:

- CLI/API for workspace/project/inbox/connection/artifact operations.
- JSON output for scripts.
- Server-side setup/diagnostic commands for Spark daemon registration tokens and workspace connection health.
- Diagnostics for connection status, logs, stale mirrored invocations, and lazy artifact cache state.
- Direct Spark daemon diagnostic/pairing channel is a design placeholder only in v0.1; diagnostic commands must not become normal browser-to-Spark daemon product traffic.

Surfaces in `apps/spark-daemon`:

- `spark daemon` commands for install/login/workspace registration/start/stop/status/logs/doctor.
- Workspace commands such as add/list/bind/reconcile.
- Spark-runtime-backed execution, local workspace registry, WebSocket session, and projection delivery for Spark-owned artifact state.

Tests:

- CLI commands work headlessly with JSON output.
- Spark daemon setup flow is scriptable.
- Diagnostic commands do not bypass normal server auth/audit for product mutations.
- No direct diagnostic/pairing implementation ships in v0.1 unless explicitly re-scoped.

## Spark bridge backlog and usable MVP plan

The completed backlog below is now classified as a repo-local **Spark daemon-backed development build**, not a complete usable MVP. It proves this repository's SvelteKit frontend/server, `apps/spark-daemon` daemon skeleton, SQLite projection stores, protocol contracts, connection diagnostics, cockpit/inbox/task/artifact UI, and Spark daemon smoke fixture. The merged Spark slice now covers UI-generated enrollment tokens plus browser-queued `task.start.request` commands through the Spark runtime bridge with status/log/artifact projection. Remaining usable MVP work is the hardened Spark daemon lifecycle, human ask bridge depth, artifact content bridge, resource/spec dispatch, and retry/cancel/error UX; see [`docs/plans/release-roadmap.md`](./docs/plans/release-roadmap.md).

| Order | Workstream                        | Depends on                                  | MVP outcome                                                                                                                                                                                          |
| ----: | --------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Schema/projection migration       | Slice 0                                     | Add projects, resources, agent specs, server commands/deliveries, human requests/responses/inbox, task graph projections, invocations/logs, artifact/cache tables, and tests.                        |
|     2 | Spark daemon/browser protocol contracts | Slice 0                                     | Add Zod schemas and fixtures for workspace snapshots, commands, human requests/responses, task graph snapshots, invocation/log updates, and artifact projections.                                    |
|     3 | Thin DB services                  | Schema + protocol                           | Centralize workspace/project creation, owner binding, event append, projection ingestion, inbox mutation, and artifact metadata/cache helpers.                                                       |
|     4 | Spark daemon ingestion/delivery channel | DB services                                 | Extend Spark daemon WS/API beyond hello/heartbeat to persist projections and deliver/ack/reject queued commands and human responses.                                                                       |
|     5 | Liveness + SSE                    | Spark daemon ingestion                            | Mark stale Spark daemons/sessions and fan out useful append-only events to browser pages.                                                                                                                  |
|     6 | Workspace/project flows           | DB services + liveness                      | Done: workspace creation from Spark daemon bindings, project list/create/detail routes, cockpit projection summaries, and enabled Projects navigation.                                                     |
|     7 | Web ask inbox                     | Spark daemon ingestion + projects                 | Done: `/inbox` lists Spark-daemon-originated asks/reviews, persists user answers through projection services, exposes resolved/delivery state, and retries delivery to owner bindings without timeout.     |
|     8 | Task graph projection UI          | Spark bridge ingestion + projects           | Done: render Spark-owned DAG snapshots, task dependencies, status summaries, and invocation links in the project cockpit without server-side execution truth.                                        |
|     9 | Evidence/artifact board           | Spark daemon ingestion + projects                 | Done: `/artifacts` lists workspace/project evidence, detail pages show provenance/content pointers/links, and preview cache metadata/API is lazy under the XDG server artifact cache.                |
|    10 | Resources and agent specs         | Workspace/project flows                     | Done: `/repos` and `/agents` support projectless workspace resources plus reusable agent specs with create, archive/restore, and enable/disable state.                                               |
|    11 | Spark daemon smoke fixture              | Spark daemon ingestion                            | Done: Spark daemon tests register a fake Spark daemon, open WS, send hello/heartbeat plus sample projections, and verify SQLite + web/API paths alongside the real `apps/spark-daemon` scaffold.             |
|    12 | UI polish/unlock                  | Inbox + graph + artifacts + resources/specs | Done: implemented nav is enabled, post-MVP actions remain disabled + Coming soon, no-workspace initialization uses a full-screen setup shell, and small-screen shell spacing/brand labels are clean. |
|    13 | Validation/release gate           | Smoke + UI polish                           | Done: `pnpm check`, `pnpm test`, `pnpm build`, `pnpm exec vp fmt --check .`, migration tests, and isolated Spark daemon smoke are green under Node 26.                                                     |
|    14 | Docs/handoff                      | Validation gate                             | Done: README, implementation plan, progress, known limitations, validation evidence, and next post-MVP/git-root decision notes are current.                                                          |

Git root handoff: `navia/` has been initialized as its own Git repository after explicit approval. No initial commit has been created yet because the selected action was init-only.
