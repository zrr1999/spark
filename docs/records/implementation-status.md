# Implementation status

This repo has the Spark package skeleton, Spark-owned `spark-*` capability packages, the retained out-of-scope `pi-btw` package, and an end-to-end local vertical slice. Retired migration packages such as `spark-core` and `spark-goal` are no longer workspaces.

Package naming now follows [`spark-capabilities-and-generative-ui.md`](../architecture/spark-capabilities-and-generative-ui.md): Spark-owned capabilities use `spark-*`, public tool names stay stable, and `pi-btw` remains out of scope.

## Implemented

- `spark-extension-api`
  - shared extension host/tool contract
  - refs, errors, task/run/review types, copy-language detection, and light JSON/fs/time helpers used by both Pi extension host and the Spark native host family
- `spark-artifacts`
  - generic artifact/evidence store and canonical `artifact` action tool for `record`, `list`, `read`, `link`, and `compact`
  - preserves physical Spark artifact layout under `.spark/artifacts` through `defaultArtifactStore(cwd)`
- `spark-tasks`
  - generic project/task/TODO/run graph capability and canonical `task({ action })` tool
  - `TaskGraphStore` backed by the V2 `.spark/projects/` project/task file tree, content-aware owner-file writes, `.spark/projects/index.lock` plus `.spark/projects/locks/<project>.lock` lock directories, stale direct-save protection, dependency/readiness checks, task names/titles/descriptions, run state, unified claim/lease schema, heartbeat and stale-claim expiry
  - task plan item state outside `.spark/projects/` in canonical `.spark/todos/todos.sqlite`; legacy TODO JSON files and session-scoped snapshots are import-only
- `spark-learnings`
  - generic evidence-backed `learning` / `learning-candidate` / `learning-export` records
  - deterministic reflection candidate inbox, session scanner, synthesis engine, and `/reflect` scheduler logic shared through Pi-compatible shims
  - canonical `learning({ action })` tool
  - `.learnings/` repo/workspace/user stores, active/candidate/stale/superseded/rejected lifecycle, keyword search, and explicit Markdown export/import
- `spark-loop`
  - generic loop lifecycle/tick primitives, durable goal primitives, continuation prompt helpers, and session goal/loop stores
  - Spark keeps project-bound `/loop` and `/goal` command/tool facades; historical serialized marker strings remain stable until an explicit migration changes them
- `spark-workflows`
  - canonical `workflow` list/read tool for saved scripts in controlled workspace `.spark/workflows/*.js` and user `~/.agents/workflows/*.js` roots
  - workflow metadata/runtime primitives and `.spark/workflow-runs.json` workflow-run store with scheduling/reconciliation/retention helpers
  - no inline workflow execution and no `/goal` aliasing; execution remains explicit host/runtime policy
- `spark-context`
  - registered context provider contracts and canonical `context` list/preview tool with per-provider budgets
  - Spark registers `spark.active` as a bounded provider for active project/task/TODO/SPARK.md context
  - freeform system prompt injection is intentionally not supported
- `spark-memory`
  - unified explicit scoped memory entries with `remember | recall | search | status | forget`, keyword scoring, secret scanning, and policy-only prompting
  - first owner layer over the memory direction while keeping `learning` and `recall` public surfaces stable
- `spark-recall`
  - controlled explicit-scope `user | workspace | repo` recall candidate store and canonical `recall` tool
  - candidate record/list/search/reject lifecycle only; no automatic memory promotion and no `.learnings/` writes
- `spark-ask`
  - canonical public/default `ask` action tool that dispatches focused asks and multi/flow requests through internal shared implementations
  - shared result semantics across focused and flow renderers: explicit envelopes, no automatic timeout decisions, stable option ids in structured values, label/description summaries, consistent decision/approval blocking, and first-class direct custom input
- `spark-cue`
  - migrated cue-shell IPC client and full direct tool surface
  - raw TypeScript imports compatible with Pi / Node strip-types loading
  - daemon auto-start and bash disable policy
- `spark-roles`
  - reusable `RoleSpec` definitions with `builtin | extension | project | user` sources
  - builtin roles (`scout`, `reviewer`, `worker`) as generic role specs with audited capability profiles: scout=`read+net`, reviewer=`read+net+exec`, worker=`read+net+exec+write`; no builtin role receives `interact`, `spawn`, `ask`, `task`, `task_read`, `task_write`, `goal`, `role`, `assign`, `workflow`, or `graft_patch`
  - extension role registration, project/user Markdown role stores, canonical public/default `role` action tool, task-agnostic direct `role({ action: "call" })`, fresh/forked run modes, explicit fork source requirements, JSONL parsing, active-run listing/cancellation, timeout signalling
- `spark-runtime`
  - Spark single-task adapter over `spark-roles`
  - dry-run and real task execution, runtime-created role-run claims, heartbeat loop, artifact persistence, timeout/reconciliation tracking, active child process tracking, kill/input controls, failed-delivery reporting, and role-run transcript compaction support
- `spark-host`
  - shared Spark-native ExtensionAPI host runtime, host-neutral runtime types, keybinding registry, tool/command/event/outbox/interaction plumbing, and compatibility adapters for the TUI app
- `spark-turn`
  - shared Spark-native agent turn loop (`SparkAgentLoop` / `SparkTurnRunner`) covering model stream orchestration, tool roundtrips, approval gates, abort handling, outbox draining, and view-event projection
- `spark`
  - Spark default research behavior plus `/plan`, `/implement`, `/goal`, `/loop`, and `/workflow[:selector]` commands
  - Spark widget, role-run status/widget surfaces, mode state, active context provider, session-bound goal facade, review/init flow state, builtin Spark roles, and role/model binding policy
  - canonical visible tool surface through `task_read`, `task_write`, `assign`, `learning`, `artifact`, `ask`, `context`, `workflow`, `role`, `recall`, and `goal`; retired `spark_*` tool configs are not kept as internal dispatch wiring
  - always-available research-default standing mode, with project-bound context appended only after a graph/current project exists
  - state initialization without generic project-idea intake templates; clarification/decision asks are grounded in inspected context, while SPARK.md idea-capture prompts live in external skills
  - root `SPARK.md` materialization only during bootstrap initialization when `.git` exists in cwd; direct project-bound modes keep intent under `.spark` artifacts
  - role-run registry/TUI integration for active, waiting, replied, failed, stale/interrupted, and completed background roles; reply/steer controls record provenance and refresh visible `spark-role-runs` surfaces; validated against the role TUI audit (`artifact:5a554db7-6438-441f-b525-1f57ba4aef02`), closed the stop-refresh/failed-delivery needs-change review (`artifact:f43da8ee-bf94-41ea-ba72-bb162fa5e138`), and has approved control evidence (`artifact:223c907d-7034-4e18-8818-568c34ab03fa`, review `artifact:c00e9bed-c67d-42f4-90f0-410dad1bb06c`)
  - evidence-gated stale-claim recovery through `task_write({ action: "recover" })` and claim-time recovery through `task_write({ action: "claim" })`, preserving ready-frontier safety without automatic task completion; final evidence `artifact:a1b457f8-796b-471c-ac68-c6eb8e052999` approved by `artifact:7dfac593-f43b-4f04-8660-6d95f59a3d49`
- `spark-cli`
  - thin root dispatcher for public `spark ...` commands; it routes to app packages and does not own TUI, daemon, host, or turn runtime logic
- `spark-tui-app`
  - native Spark-first `pi-tui` app with explicit builtin extension loading, provider registry, model selector, JSONL session store, skill resolver, local daemon client/queue surfaces, and shared `spark-host` / `spark-turn` core
  - extension packages depend on `spark-extension-api`, not on Pi's concrete SDK runtime
- `spark-daemon`
  - local daemon queue/lock/worker/IPC app with `session.run` execution routed through Spark's headless session executor backed by `spark-host` / `spark-turn`
  - no `createAgentSession` or `@earendil-works/pi-coding-agent` dependency in daemon core paths

## Boundary guard status

- `pi-extension` remains a legacy-compatible Pi facade while owner packages absorb core domains; `pi-btw` remains explicitly out of scope for the Spark capability rename.
- `scripts/check-pi-boundaries.mjs` keeps retained `pi-*` packages independent from Spark product packages while allowing renamed Spark foundation packages and the `spark-tui` presentation boundary where required.
- Spark shared packages must not import Cockpit/daemon/app host internals.
- `pnpm run check` runs the boundary checker, and `prek.toml` wires it directly as `pi-boundary-check`; CI static checks run `prek`, so the guard runs in CI.
- The guard intentionally checks dependency/import boundaries, not arbitrary historical strings; on-disk schema marker strings such as goal continuation markers remain allowed until an explicit migration changes them.

## Current public tool surface

- `task({ action })` owns project/task/TODO/run/status/cache-cleanup actions.
- `goal({ action })` owns Spark session-bound goal actions through the Spark facade; session goal state is stored by `spark-loop`.
- `artifact({ action })` owns evidence/artifact records.
- `learning({ action })` owns evidence-backed reusable learnings.
- `ask({ action })` owns user-question UX and result semantics.
- `context({ action })`, `recall`, `workflow({ action })`, `role({ action })`, `spark-cue`, and `spark-graft` tools remain canonical generic surfaces; patcher-style child runs belong to explicit extension roles, not the Spark facade.
- Public/default action tools render as `tool action=<value> ...`; do not keep fragmented duplicate surfaces public when a canonical action tool owns the domain.

## Deferred by design

- `spark-github`
- full autonomous scheduler daemon beyond the current local Spark daemon queue
- production-grade non-Pi child role executor
- worktree/merge/release gates
- optional micro-splitting of large implementation files that no longer block package boundary correctness
