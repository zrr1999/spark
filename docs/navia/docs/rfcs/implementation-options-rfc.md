# RFC: Navia v0.1 implementation options

Status: selected for v0.1 development
Date: 2026-05-21

## Summary

This RFC freezes the remaining implementation-level choices before code starts. The goal is to make the first development pass boring: scaffold one SvelteKit app, one separate `apps/spark-daemon` process, a small set of high-cohesion packages, SQLite-backed server/Spark daemon stores, one protocol package, and enough test fixtures to validate the Spark daemon boundary.

No further product decisions are required before starting the first code slice. Future hosted/team Spark daemon implementation questions are explicitly deferred unless noted below.

## Selected defaults

| ID  | Area                      | v0.1 choice                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | Repository layout         | pnpm monorepo at `navia/` project root with one initial app `apps/web` and packages `packages/protocol`, `packages/db`, `packages/domain`, and `packages/ui`. Do not create `apps/server` in v0.1.                                                                                                                                                                              |
| I02 | Code terminology          | Use **workspace registration** and **workspace directory** for product/operator-facing setup flows. Use **Spark daemon** when naming the `spark daemon` command group, `@zendev-lab/spark-daemon` package, or local daemon implementation boundary. Keep **runtime** only for existing protocol/API route/database/wire-contract identifiers such as `/api/v1/runtime/*`, `runtime.hello`, and `runtime_workspace_bindings`. |
| I03 | Runtime                   | Node.js 26, ESM-only TypeScript.                                                                                                                                                                                                                                                                                                                                                |
| I04 | Package manager           | pnpm with Corepack; root `pnpm-workspace.yaml`.                                                                                                                                                                                                                                                                                                                                 |
| I05 | Web/app framework         | SvelteKit full-stack app with `@sveltejs/adapter-node`.                                                                                                                                                                                                                                                                                                                         |
| I06 | Spark daemon WebSocket support  | Attach `ws` to a custom Node server around the SvelteKit handler; do not try to model the Spark daemon protocol WS as a normal SvelteKit route handler.                                                                                                                                                                                                                               |
| I07 | Frontend realtime         | SSE for browser event streams via `/api/v1/events`; Spark daemon control remains WebSocket-only.                                                                                                                                                                                                                                                                                      |
| I08 | UI implementation         | Svelte 5/SvelteKit, token-first CSS variables from `DESIGN.md`, lightweight/custom Navia components, direct Bits UI headless primitives where accessibility matters, and lucide-style icons. Avoid adopting shadcn-svelte's generated component tree.                                                                                                                           |
| I09 | Task graph rendering      | Use an interactive graph component only after the projection schema exists; initial scaffold may render a deterministic DAG list/tree, then upgrade to a graph view.                                                                                                                                                                                                            |
| I10 | Protocol package          | `packages/protocol` owns Zod schemas, message envelopes, shared refs, JSON fixtures, and optional OpenAPI generation helpers.                                                                                                                                                                                                                                                   |
| I11 | API route prefixes        | Browser/product APIs use `/api/v1/*`; external runtime protocol uses `/api/v1/runtime/*`.                                                                                                                                                                                                                                                                                       |
| I12 | API errors                | JSON error envelope: `{ "error": { "code", "message", "details"?, "requestId"? } }`.                                                                                                                                                                                                                                                                                            |
| I13 | Protocol versioning       | Spark daemon protocol string is `navia.runtime.v1alpha1`; HTTP path is `/api/v1/runtime/*`; pre-v1 unsupported versions fail loudly.                                                                                                                                                                                                                                                  |
| I14 | Database file             | Server DB defaults to `${XDG_DATA_HOME:-~/.local/share}/navia/server/navia.sqlite`; Spark daemon DB defaults to `${XDG_DATA_HOME:-~/.local/share}/spark/daemon/daemon.sqlite`. Explicit env overrides may point tests/dev smoke at repo-local paths.                                                                                                                                  |
| I15 | SQLite driver             | Native `node:sqlite` on Node 26.                                                                                                                                                                                                                                                                                                                                                |
| I16 | Query layer               | Kysely with a thin `node:sqlite` adapter/dialect owned by this repo.                                                                                                                                                                                                                                                                                                            |
| I17 | SQLite pragmas            | Enable `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`, and application-level migrations at server start/CLI.                                                                                                                                                                                                                                                        |
| I18 | Migrations                | Explicit SQL migrations in `packages/db/src/migrations`; small TS Spark daemon records applied migrations.                                                                                                                                                                                                                                                                            |
| I19 | IDs                       | Text IDs with stable prefixes plus `crypto.randomUUID()` without dashes, e.g. `ws_...`, `proj_...`, `rt_...`, `cmd_...`. Sort by timestamps, not ID text.                                                                                                                                                                                                                       |
| I20 | Timestamps                | Store UTC ISO-8601 `TEXT` timestamps in SQLite; API payloads also use UTC ISO strings.                                                                                                                                                                                                                                                                                          |
| I21 | JSON columns              | Store structured payloads as JSON `TEXT` and validate with Zod at all read/write boundaries.                                                                                                                                                                                                                                                                                    |
| I22 | Projection persistence    | Persist raw snapshots/events and normalized query tables for latest UI projections. Do not fetch project/task state on demand from the Spark daemon for normal page loads.                                                                                                                                                                                                            |
| I23 | Task graph snapshots      | Spark-runtime-owned truth. Server stores raw snapshots, replaces normalized projection rows transactionally, and keeps append-only events for audit.                                                                                                                                                                                                                            |
| I24 | Auth mode                 | Local-first single-owner bootstrap for v0.1. First setup creates an owner session; hosted/team auth is deferred.                                                                                                                                                                                                                                                                |
| I25 | Browser sessions          | HttpOnly SameSite=Lax cookie, 30-day local session by default, CSRF token for unsafe browser mutations.                                                                                                                                                                                                                                                                         |
| I26 | Dev auth bypass           | Only via explicit env flag and loopback binding; never enabled by default.                                                                                                                                                                                                                                                                                                      |
| I27 | Spark daemon auth               | One-time enrollment token -> hashed Spark daemon token. Store only token hashes; support revoke/rotate.                                                                                                                                                                                                                                                                               |
| I28 | Spark daemon heartbeat          | Spark daemon sends heartbeat every 15s; server marks stale/offline after 45s or closed WS, but never auto-fails invocations from liveness alone.                                                                                                                                                                                                                                      |
| I29 | Command delivery          | Server-owned delivery state with idempotency keys; commands route only to the workspace's owning Spark daemon binding.                                                                                                                                                                                                                                                                |
| I30 | Human requests            | Spark daemon-originated, idempotent by `(runtime_binding_id, runtime_request_id)`, wait indefinitely, and redeliver answered-but-unacked responses after reconnect.                                                                                                                                                                                                                   |
| I31 | Reminders                 | Store `next_reminder_at`; v0.1 shows badges/visible reminders. No email/push and no automatic timeout.                                                                                                                                                                                                                                                                          |
| I32 | Artifact cache            | Server lazy cache under `${XDG_CACHE_HOME:-~/.cache}/navia/server/artifacts`, content-addressed where possible, preview-first then unpinned LRU/TTL/size-cap eviction. Spark daemon canonical artifacts live under Spark daemon XDG data.                                                                                                                                                   |
| I33 | Artifact content API      | `GET /api/v1/runtime/artifacts/:artifactId/content` serves cache or starts lazy fill; return explicit `202 pending` / `503 runtime_offline` states instead of pretending content is available.                                                                                                                                                                                  |
| I34 | Background jobs           | In-process jobs only: stale connection sweep, response redelivery, reminder badge scheduling, artifact cleanup. Move to worker only after reliability/scale requires it.                                                                                                                                                                                                        |
| I35 | Logging                   | Structured JSON logs with request id; redact raw local paths/secrets by default.                                                                                                                                                                                                                                                                                                |
| I36 | Testing                   | Vitest for unit/integration, Svelte check for type/template validation, protocol fixture validation, migration tests from empty DB, Playwright smoke tests after app shell exists.                                                                                                                                                                                              |
| I37 | Formatting/lint           | Prettier for Markdown/Svelte/JSON, ESLint/Svelte checks where useful, strict TypeScript, `svelte-check`; wire recurring checks through `prek`.                                                                                                                                                                                                                                  |
| I38 | OpenAPI                   | Generate OpenAPI only for stable HTTP surfaces after initial route schemas settle. JSON fixtures are the first external contract.                                                                                                                                                                                                                                               |
| I39 | Spark daemon implementation     | Product Spark daemon lives in `apps/spark-daemon` as a separate process using the Spark runtime bridge. The Spark daemon smoke remains a test fixture and must not replace the product Spark daemon.                                                                                                                                                                                          |
| I40 | Direct diagnostic/pairing | Design placeholder only; no v0.1 implementation, no browser-to-Spark daemon product traffic.                                                                                                                                                                                                                                                                                          |

## Repository layout

Initial code layout:

```text
.
├── apps/
│   └── spark-cockpit/                 # @zendev-lab/spark-cockpit
│       ├── src/
│       │   ├── lib/
│       │   └── routes/
│       │       ├── (workbench)/
│       │       ├── (settings)/
│       │       └── api/v1/runtime/
│       ├── server/                # custom Node server + ws attachment
│       │   └── index.ts
│       └── package.json
├── packages/
│   ├── spark-daemon/              # @zendev-lab/spark-daemon
│   ├── navia-protocol/            # @zendev-lab/navia-protocol
│   │   ├── src/
│   │   │   ├── schemas/
│   │   │   ├── runtime-v1/
│   │   │   ├── fixtures/
│   │   │   └── index.ts
│   │   └── package.json
│   ├── navia-db/                  # @zendev-lab/navia-db
│   │   ├── src/migrations/
│   │   └── package.json
│   ├── navia-domain/              # @zendev-lab/navia-domain
│   │   └── package.json
│   └── navia-ui/                  # @zendev-lab/navia-ui
│       └── package.json
├── pnpm-workspace.yaml
├── package.json
├── prek.toml
└── .node-version
```

Delay these until needed:

- `apps/server` — do not create initially; SvelteKit does not need a separate server app for v0.1.
- `apps/workbench` / `apps/admin` — only if workbench and management become separate deployment/app boundaries.
- `packages/sdk` — only after an external TS client is needed beyond protocol fixtures.
- Multi-provider Spark daemon abstraction — v0.1 uses the Spark runtime bridge in `apps/spark-daemon`; no separate Spark daemon repo by default.

## Auth and local setup

v0.1 auth is local-first and explicit:

1. Server binds to loopback by default.
2. First launch creates a setup token in the XDG server state/config area and/or prints it once to the console.
3. Visiting the setup URL exchanges the setup token for the initial owner session.
4. Browser sessions are stored in SQLite as hashed session tokens.
5. Unsafe browser mutations require CSRF protection.
6. Spark daemon enrollment tokens are created by the owner and exchanged once for Spark daemon tokens.
7. Spark daemon tokens are hashed at rest and scoped to Spark daemon identity/workspace grants.

Hosted/team auth, OAuth, SSO, device-code login, and multi-user roles beyond the owner/member schema are deferred.

## Protocol envelope

Every WebSocket message uses a common envelope:

```ts
interface RuntimeEnvelope<TPayload> {
   protocolVersion: "navia.runtime.v1alpha1";
   messageId: string;
   idempotencyKey?: string;
   type: string;
   sentAt: string;
   workspaceBindingId?: string;
   payload: TPayload;
}
```

Rules:

- `messageId` is unique per send attempt.
- `idempotencyKey` is stable across retries for state-changing messages.
- Unsupported `protocolVersion` returns/records `unsupported_protocol_version` and closes or rejects the flow loudly.
- The server does not maintain broad pre-v1 compatibility shims.

## Data persistence stance

Normal UI page loads query SQLite projections. Spark daemon snapshots/events update those projections. The server may request reconciliation, but it does not fetch task graph state from the Spark daemon on every page load.

Concrete schema is specified in [`data-model-rfc.md`](./data-model-rfc.md).

## First development slice

Start with this vertical slice:

1. Root pnpm workspace, Node 26 pin, basic scripts.
2. `packages/protocol` with refs, envelope schemas, error schema, and first fixtures.
3. `apps/web` SvelteKit app shell with adapter-node and custom server placeholder for Spark daemon WS.
4. `packages/db` SQLite client, pragmas, Kysely adapter shell, migration runner, and `0001_initial.sql` for core workspace/auth/runtime tables.
5. Local owner setup/session flow.
6. Spark daemon registration endpoint and token exchange.
7. Spark daemon WS hello/heartbeat against a protocol test client.
8. Workspace overview page backed by SQLite.
9. `pnpm check` and `pnpm test` passing.

Do not start with the full UI, full task graph renderer, or real Spark daemon provider execution. Those depend on the core protocol/data spine.

## Deferred implementation details

The following remain intentionally out of v0.1 implementation, even though schema/protocol leaves room for them:

- direct browser-to-Spark daemon diagnostic/pairing;
- user-submitted pre-project request intake;
- workspace owner binding migration/rebinding;
- multi-Spark daemon co-management of one workspace;
- hosted/team auth and billing/org model;
- OAuth/device-code Spark daemon login;
- object storage and signed uploads;
- provider-specific session resume details;
- interactive terminal relay;
- server-side provider scheduling or workdir leasing.
