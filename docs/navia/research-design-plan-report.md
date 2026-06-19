# Navia research and design plan report

Date: 2026-05-20
Updated: 2026-05-21

## Objective

Produce a compact research/design plan for Navia's workspace/project product model and next implementation direction, using supplied dashboard screenshots and references from Loom, sixbones.dev, spore-lang.dev, Multica, and awesome-design-md.

## Project boundary correction

This document is about the standalone **Navia** product/project in this workspace. It is not the `pi-spark` repository and not a Pi extension. Pi-specific concepts such as a `/spark` command, `spark_status`, Pi widget state, or pi-spark's current cluster store must be treated as integration/prototype references only, not as constraints on Navia's product architecture.

## Executive recommendation

Navia should be a **workspace/project-first agentic project dashboard** implemented as a lightweight SvelteKit product app with an external runtime boundary.

1. **SvelteKit frontend** — workspace/project-first web product surface for full cockpit, inbox/web ask, evidence board, task graph projection, run status, and connection health. It can use Elm-style internal model/update/view discipline, but should downplay runtime identity as a primary concept.
2. **SvelteKit server routes** — TypeScript communication/projection plane backed by SQLite; owns auth, sessions/tokens, workspace bindings, command/human-response delivery records, frontend projections, events/audit, lazy artifact cache/proxy, and web fanout.
3. **External runtime** — implemented outside this repo; owns task graph truth, provider CLIs, local orchestration, workspace/repo/workdir management, logs/checkpoints, canonical artifacts, and safety policy.

Within the product model, keep the workspace/project/runtime split:

- **Workspace product/UI plane** — projects, repos/resources, agent specs, reusable workspace artifact projections, members/settings, connection health. Workspace may exist with zero projects; resources, agent specs, and workspace artifacts may exist before projects.
- **Project execution/collaboration plane** — inbox/web ask, task graph projections/snapshots, runs/invocations, reviews, project artifacts/evidence, current conclusion.
- **Runtime capability plane** — task graph execution truth, local orchestration, workdir safety, logs/checkpoints, canonical runtime artifacts.

This moves Navia away from the earlier pure local filesystem-watch/narrow-backend-only direction, the thin-Spark daemon/server-scheduler framing, and the earlier Hono/PostgreSQL-first backend baseline. Files remain important as evidence/artifact/workspace surfaces, but SvelteKit + SQLite own the lightweight communication/projection state for the web app.

Default user traffic should be server-mediated: browser/user actions go through Navia's SvelteKit server. Direct user/browser-to-runtime connection is not a v0.1 product path because it bypasses auth, audit, inbox delivery, artifact cache, and projection consistency. Keep only a design placeholder for a privileged direct diagnostic/pairing channel; do not implement it in v0.1 unless explicitly re-scoped.

The UI direction should be a **light operational dashboard for engineers**: precise, data-dense, low-decoration, strong semantic color, and product evidence as the hero. Use a Linear-like information hierarchy adapted to the supplied light dashboard screenshots, and follow `DESIGN.md` token/interaction discipline.

## Screenshot takeaways

### Workspace projects view

The first screenshot shows Navia as a workspace-level control surface:

- left navigation: Overview, Projects, Repos, Agents, Artifacts, Settings;
- top stats: total projects, running projects, pending decisions, completed/archived;
- project list with progress, pending decisions, recent artifacts, latest conclusion, update time;
- right rail for recent project activity.

This implies workspace-level ownership of:

- project registry, possibly empty;
- repo/resource registry;
- agent specs;
- global/workspace artifact discovery;
- workspace settings and member/account state.

### Project detail view

The second screenshot shows Navia as a concrete execution cockpit:

- task execution overview grouped by cluster/task graph projection;
- pending decision queue/inbox;
- artifacts/evidence board;
- current conclusion and confidence/evidence status;
- reports, metrics, logs, charts, patches, summaries.

This implies project-level ownership of:

- inbox / pending decisions;
- task graph projections;
- runs/invocations;
- project artifacts and evidence;
- asks/reviews;
- current conclusion state.

Runtime-side workdirs/checkouts and canonical task graph truth support those invocations but are not owned by the frontend UI or SvelteKit server.

## Reference findings

### Loom

Loom contributes the strongest execution-state model:

- inspectable state and explicit audit trails;
- requests/inbox as human intake;
- clusters/tasks with explicit state transitions;
- ownership/lease concepts to avoid mutation conflicts;
- shared output/product tree;
- manager/worker/reviewer role split;
- explicit CLI surfaces and generated docs.

Navia should borrow:

- inspectable state and explicit audit trails;
- inbox/attention separation from execution state;
- lease/ownership concepts for mutating code tasks, reflected as runtime-side safety;
- shared reviewable artifact/product tree;
- event log and explicit state transitions.

Navia should not blindly copy:

- Loom's single-repo/single-project assumption;
- filesystem files as the only product state source;
- worker-local worktree ownership as the primary product model.

### sixbones.dev

sixbones.dev contributes a strong frontend/docs/CI baseline:

- pnpm workspace with pinned package manager;
- Vite+ (`vp`) as unified checks/tooling;
- `prek` install in `prepare`;
- CI for static checks, PR title validation, typos, Vale, links;
- docs and generated references.

Navia should reuse this infrastructure standard, but not Astro.

Recommended baseline:

- pnpm workspaces and catalog/overrides;
- SvelteKit app under `apps/web`;
- Vite+ where possible for `vp fmt`, `vp lint`, `vp check`;
- `prek` with check-yaml/json/toml, typos, actionlint, zendev, and project checks;
- CI matching local checks;
- docs and generated reference checks where useful.

### spore-lang.dev

spore-lang.dev contributes a docs/design-contract pattern:

- strong docs quality gates;
- `DESIGN.md` as an AI-readable design system contract with tokens and prose rules.

Navia should keep `DESIGN.md` as the durable interface contract agents read before generating UI.

Caution: spore uses Astro/Starlight/AstroPaper; Navia should not use Astro.

### Multica

Multica contributes the clearest product architecture reference:

- workspace as boundary;
- projects as high-level containers;
- runtimes/daemon as execution environments;
- project resources as typed pointers to repos/docs;
- inbox as human attention queue;
- server state vs client state split;
- realtime invalidation/event streams;
- CLI as a first-class automation/control surface;
- registration, heartbeat, liveness, local CLI execution, logs, and artifact reporting;
- token-driven UI discipline.

Navia should adapt, not copy:

- Navia has inbox, artifacts, asks/reviews, task graph projections, and evidence-first UI as native concepts, not Multica's issue-centric model wholesale.
- Current Navia repo should implement SvelteKit frontend/server and protocol/projection surfaces.
- Runtime implementation should live outside this repo.
- Runtime owns task graph truth and local execution details; SvelteKit server coordinates communication and persists projections.

### awesome-design-md

Candidate design systems considered:

- **Linear** — best conceptual match for engineer workflow/project management; precise, minimal, product-screenshot-led.
- **Notion** — strong workspace metaphor, but too colorful/illustrative for dense agent ops.
- **Airtable** — structured data/productivity fit, but less agent/devtools-native.
- **Claude** — warm AI product narrative; good for landing, not dashboard.
- **Voltagent** — agent/devtools-native but dark/terminal-heavy; not aligned with supplied light dashboard.

Chosen base: **Linear-like precision adapted to light operational dashboard**.

## Proposed product model

```text
SvelteKit server + SQLite
├── workspaces
│   ├── projects              # optional; workspace may be projectless
│   ├── repos/resources        # may exist before project
│   ├── agentSpecs             # may exist before project
│   ├── runtime connections/bindings
│   ├── artifacts              # reusable/global evidence metadata + lazy cache pointers
│   ├── members/settings
│   └── activity/events
└── communication/events/projections

Project
├── resources
├── inbox                    # web ask/review attention surface
├── taskGraphProjection      # runtime-owned truth mirrored into Navia
├── artifacts                # reports, metrics, logs, patches, conclusions
├── asks
├── reviews
├── runs/invocations         # runtime-reported projections
└── events

Runtime communication/projection surface in this repo
├── connection identity/session/token state
├── workspace bindings
├── workspace snapshots/projections
├── task graph snapshots/projections
├── command routing/delivery records
├── human request/response delivery records
├── heartbeat/liveness/diagnostics
└── reported logs/events/artifact projections

External runtime implementation
├── owns canonical task graph truth
├── manages multiple workspace bindings
├── local workdirs/checkouts/repo state
├── provider CLI detection/invocation
├── local orchestration/scheduling
├── local logs/checkpoints/canonical artifacts
├── packaging/update/service install
└── runtime-side safety policy
```

Important distinctions:

- **SvelteKit server routes + SQLite** are the communication/projection owner in this repo.
- **Runtime communication/projection model** is owned by this repo; **runtime implementation** is owned separately.
- **AgentSpec** is reusable and workspace-owned.
- **AgentRun/Invocation** is concrete and project/task-projection-owned evidence.
- **Repo/Resource** is registered at workspace level and attached to projects through resources.
- **Artifact** has scope: workspace or project; task/run/review/ask records link artifacts but do not physically own them.
- **Inbox** is project-level web ask/attention queue for runtime-originated asks, decisions, approvals, blockers, review gates, and selected external events.
- **Request intake** means user-submitted pre-project ideas/briefs that can be triaged into a project. This is deferred for v0.1 unless explicitly designed.

## Suggested data model vocabulary

| Concept             | Owner                   | Notes                                                                             |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| Workspace           | root                    | account/team boundary and asset registry; may exist without projects              |
| Project             | workspace               | concrete work container                                                           |
| Repo                | workspace               | reusable repo registration and trust/allowlist                                    |
| WorkspaceResource   | workspace               | reusable resource before any project                                              |
| ProjectResource     | project                 | typed pointer to repo/doc/dataset/etc.                                            |
| AgentSpec           | workspace               | reusable role/provider/prompt/tool policy                                         |
| AgentRun            | project/task projection | concrete run with logs, status, output artifacts                                  |
| TaskGraphProjection | project                 | runtime-owned graph mirrored for cockpit/status                                   |
| InboxItem           | project                 | human attention/triage item                                                       |
| Artifact            | workspace/project       | typed evidence with provenance and lazy content cache pointer                     |
| Ask                 | project                 | structured decision request; materializes inbox item                              |
| Review              | project                 | review gate/acceptance result                                                     |
| RuntimeConnection   | workspace/projection    | deployable execution connection with capabilities, heartbeat, local availability  |
| Workdir/checkout    | runtime                 | runtime-owned local execution detail, linked to invocation provenance when needed |

## Design direction

Use the supplied screenshots as the base interaction model:

- light canvas;
- fixed left navigation;
- top workspace/project breadcrumb;
- card-based overview;
- dense but calm tables/lists;
- three-column project cockpit;
- semantic badges for running/blocked/completed/pending;
- evidence board as a major surface, not a download afterthought;
- logs/code surfaces in dark mono cards only where appropriate.

## Smallest useful implementation sequence

The product should still build the full cockpit/evidence/inbox/task-graph surfaces, but stage infrastructure in thin vertical slices.

1. **SvelteKit + SQLite communication/projection model RFC**
   - Define SvelteKit-server-owned communication records and projections: Workspace, Project, RuntimeConnection, RuntimeWorkspaceBinding, WorkspaceSnapshot, TaskGraphSnapshot, CommandDelivery, Invocation projections, Inbox, ArtifactProjection, ArtifactCacheBlob, Review, and Event records.
   - Use Node 26 native `node:sqlite` as the SQLite driver baseline, with a thin Kysely adapter/dialect and explicit SQL migration runner.
   - If importing prototype cluster/task data is needed, handle it through an adapter or migration; do not make pi-spark's cluster store the product source of truth.

2. **Full SvelteKit frontend application shell**
   - Build workspace overview/projects page, project cockpit, inbox, evidence board, task graph projection, run status, resources, agent specs, settings, and diagnostics against SvelteKit server APIs/events.
   - Keep UI state transient and avoid duplicating server product truth in ad-hoc stores.

3. **External runtime protocol**
   - Define registration, workspace bindings, workspace snapshots, task graph snapshots, required WebSocket control, server command routing, ack/reject, cancellation, log streaming, artifact projections, lazy cache/proxy requests, and reconciliation.
   - Keep implementation in a separate runtime repo; this repo only ships protocol fixtures/types, SvelteKit communication endpoints, projections, and UI.

4. **Web ask inbox**
   - Runtime-originated asks/reviews become inbox items.
   - User answers stay pending indefinitely until answer/cancel/archive.
   - Answers update artifacts/projections and are delivered back through the owning workspace binding.

5. **Artifact provenance + lazy cache**
   - Extend artifact projections with scope, refs, provenance, links, content/cache pointers, and invocation/review/ask links.
   - Keep canonical runtime-produced content external unless lazily cached/proxied on first frontend view/export under `.navia/cache/artifacts`.
   - Use preview-first eviction, then unpinned LRU/TTL/size-cap cleanup; never delete canonical external artifacts.
   - Add query filters for workspace/project/task/invocation/review/kind.

6. **Task graph projections**
   - Render full task graph UI from runtime-owned snapshots/projections.
   - Navia may display dependencies/status/run links and audit projection changes, but does not own task claiming/execution truth.

7. **CLI/control surfaces**
   - Provide automation-friendly CLI/API controls with JSON output for workspace/project/inbox/connection/artifact operations.
   - Diagnostics must remain server-mediated and audited; no default direct browser/runtime product path.
   - Direct diagnostic/pairing remains a design placeholder only in v0.1.

## Boundary invariants

1. **Workspace is the reusable asset boundary.** Projects, resources, agent specs, workspace artifacts, members/settings, and connection health belong here. Resources/specs/artifacts may exist before any project.
2. **Project is the collaboration/execution view.** Inbox, task graph projection, runs, asks/reviews, artifacts, and current conclusion belong here.
3. **Agent spec is reusable capability; agent run is historical evidence.** UI can show both an assignable spec and concrete run identity, but storage should never use a reusable spec as if it were the run owner.
4. **Artifacts are evidence nodes.** Task/run/review/ask projections link to artifacts; they do not physically own artifact blobs.
5. **Task graph truth is runtime-side.** Navia stores snapshots/projections for cockpit/status/evidence and does not own task mutation/execution truth.
6. **Runtime workdir safety first.** Navia should model capabilities, routing policy, and invocation provenance before automating checkout creation/deletion/cleanup. Destructive local operations belong behind runtime guardrails.
7. **Project status is derived unless explicitly overridden.** Running/blocked/completed can be projected from task graph snapshots, unresolved inbox items, and active runs; manual overrides should be rare and visible.
8. **User traffic is server-mediated.** Browser-to-runtime direct connection is not a normal product path in v0.1; direct diagnostic/pairing remains a design placeholder only.

## Decision summary

Confirmed product/technical decisions after review:

- D01 Product initialization root: `workspace-first`; resources, agent specs, and workspace artifacts can exist before projects.
- D02 Workspace scope: `single-local-workspace`, schema multi-workspace-ready.
- D03 Persistence boundary: `sqlite-db-with-exportable-files`.
- D04 Schema/runtime validation: `zod`.
- D05 Monorepo/package tooling: `pnpm-vp-prek`.
- D06 First app/frontend shell: `sveltekit-fullstack`.
- D07 UI component/design system: `lightweight-custom-plus-bits-ui` — custom Navia components plus direct Bits UI primitives; no shadcn-svelte generated component tree.
- D08 UI state/query model: `server-state-query-plus-elm-ui`.
- D09 Backend/API boundary: `sveltekit-server-communication-plane`.
- D10 Runtime/agent execution: `daemon-cli-thin-agent-plugins` — external daemon CLI plus thin coding-agent plugins/adapters.
- D11 Workdir/checkouts model: runtime-owned.
- D12 Repo/resource trust: server routes; runtime enforces local safety.
- D13 Inbox semantics: runtime-originated web ask inbox.
- D14 Human decision timing: `wait-indefinitely-with-reminders`.
- D15 Artifact model: `Spark-daemon-owned-artifacts-with-lazy-server-cache`.
- D16 Cluster/task model: `Spark-daemon-owned-task-graph-projections`.
- D17 Ask/review model: runtime-originated inbox-linked asks/reviews.
- D18 Events/audit log: append-only communication/product events.
- D19 Quality gates: `vp-prek-ci`.
- D20 Documentation/RFC workflow: `docs-first-rfcs`.
- D21 pi-spark integration stance: `adapter-only`.
- D22 Deployment target: server/web plus external runtime clients first.
- D23 Language/runtime split: TypeScript frontend/server in this repo; runtime implementation external.

## Risks requiring explicit design notes

| Risk                           | Failure mode                                                                        | Mitigation                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name drift                     | Docs accidentally reintroduce non-Navia terminology for standalone product concepts | Use Navia as the product name; keep Pi/pi-spark references only for explicit adapter/prototype context                                                        |
| Request intake ambiguity       | User-submitted briefs get confused with runtime-originated asks                     | Defer request intake or give it a separate RFC and lifecycle                                                                                                  |
| Inbox/task duplication         | Users see the same blocker as both a task and a decision card                       | Inbox stores attention state and links to task graph/run refs; task graph remains projection                                                                  |
| Artifact trust drift           | Evidence board loses value if provenance is optional                                | Require source run/task/review/ask or explicit workspace producer for all new artifacts                                                                       |
| Lazy cache misses              | UI feels broken when artifact content is external/unavailable                       | Show metadata first, explicit fetch/cache state, retry, and provenance/error labels; cache under `.navia/cache/artifacts` with preview-first LRU/TTL eviction |
| Runtime/workdir safety         | Bad cleanup can delete user data or dirty checkouts                                 | Runtime-owned implementation with explicit policy, dirty checks, provenance, and server-visible events                                                        |
| Direct connection temptation   | Browser-to-runtime direct path bypasses audit/projections                           | Server-mediated product traffic by default; keep direct diagnostic/pairing as design placeholder only, not v0.1 implementation                                |
| Over-generalized compatibility | Large fallback layers make schemas harder to reason about                           | Use forward normalization and direct migrations                                                                                                               |
| UI overfitting screenshots     | Dashboard looks right while storage remains wrong                                   | Drive UI from workspace/project/inbox/artifact/run/task projection queries, not hardcoded screenshot-shaped data                                              |
