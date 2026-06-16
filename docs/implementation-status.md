# Implementation status

This repo has the Spark package skeleton, canonical Pi capability packages, and an end-to-end local vertical slice. The former migration packages `spark-core`, `spark-tasks`, `spark-learnings`, `spark-goal`, and `spark-workflows` have been retired as workspaces; their generic implementation now lives under the appropriate `pi-*` packages.

## Implemented

- `pi-extension-api`
   - shared extension host/tool contract
   - refs, errors, task/run/review types, copy-language detection, and light JSON/fs/time helpers used by both Pi extension host and Spark CLI host
- `pi-artifacts`
   - generic artifact/evidence store and canonical `artifact` action tool for `record`, `list`, `read`, `link`, and `compact`
   - preserves physical Spark artifact layout under `.spark/artifacts` through `defaultArtifactStore(cwd)`
- `pi-tasks`
   - generic project/task/TODO/run graph capability and canonical `task({ action })` tool
   - `TaskGraphStore` backed by `.spark/projects.json`, atomic writes, filesystem lock directory `.spark/projects.json.lock`, stale direct-save protection, dependency/readiness checks, task names/titles/descriptions, run state, unified claim/lease schema, heartbeat and stale-claim expiry
   - task-scoped TODO state outside `.spark/projects.json`, including session-scoped `.spark/todos/<session>.json`; independent session TODOs under `.spark/session-todos/<session>.json`; stable display numbers under `.spark/todo-display-numbers/<session>.json`
- `pi-learnings`
   - generic evidence-backed `learning` / `learning-candidate` / `learning-export` records
   - canonical `learning({ action })` tool
   - `.learnings/` repo/workspace/user stores, active/candidate/stale/superseded/rejected lifecycle, keyword search, explicit Markdown export/import, and legacy `compound-learnings` import support
- `pi-goal`
   - generic durable goal primitives and continuation prompt helpers
   - Spark keeps project-bound `/goal` command/tool facade; historical serialized marker strings remain stable for compatibility
- `pi-workflows`
   - canonical `workflow` list/read tool for saved scripts in controlled workspace `.spark/workflows/*.js` and user `~/.agents/workflows/*.js` roots
   - workflow metadata/runtime primitives and `.spark/workflow-runs.json` DAG/workflow-run store with scheduling/reconciliation/retention helpers
   - no inline workflow execution and no `/goal` aliasing; execution remains explicit host/runtime policy
- `pi-context`
   - registered context provider contracts and canonical `context` list/preview tool with per-provider budgets
   - Spark registers `spark.active` as a bounded provider for active project/task/TODO/SPARK.md context
   - freeform system prompt injection is intentionally not supported
- `pi-recall`
   - controlled explicit-scope `user | workspace | repo` recall candidate store and canonical `recall` tool
   - candidate record/list/search/reject lifecycle only; no automatic memory promotion and no `.learnings/` writes
- `pi-ask`
   - canonical public/default `ask` action tool that dispatches focused asks and multi/flow requests through internal shared implementations
   - shared result semantics across focused and flow renderers: explicit envelopes, no automatic timeout decisions, stable option ids in structured values, label/description summaries, consistent decision/approval blocking, and first-class direct custom input
- `pi-cue`
   - migrated cue-shell IPC client and full direct tool surface
   - raw TypeScript imports compatible with Pi / Node strip-types loading
   - daemon auto-start and bash disable policy
- `pi-roles`
   - reusable `RoleSpec` definitions with `builtin | project | user` sources
   - builtin roles (`scout`, `planner`, `worker`, `reviewer`, `oracle`) as generic role specs; Spark facade decides how to use them
   - project/user Markdown role stores, canonical public/default `role` action tool, task-agnostic direct `role({ action: "call" })`, fresh/forked run modes, explicit fork source requirements, JSONL parsing, active-run listing/cancellation, timeout signalling
- `spark-runtime`
   - Spark single-task adapter over `pi-roles`
   - dry-run and real task execution, runtime-created role-run claims, heartbeat loop, artifact persistence, timeout/reconciliation tracking, kill controls, and role-run transcript compaction support
- `spark`
   - Spark compatibility entry plus `/research`, `/plan`, `/implement`, `/goal`, and `/workflow[:selector]` commands
   - Spark widget, mode state, active context provider, session-bound goal facade, review/init flow state, builtin Spark roles, and role/model binding policy
   - canonical visible tool surface through `task`, `learning`, `artifact`, `ask`, `context`, `workflow`, `role`, `recall`, and `goal`; legacy `spark_*` tool configs are internal implementation details only and are not registered as active tools
   - always-available research-default standing mode, with project-bound context appended only after a graph/current project exists
   - state initialization without a generic intake template; clarification/decision asks are grounded in inspected context
   - root `SPARK.md` materialization only during compatibility initialization when `.git` exists in cwd; direct project-bound modes keep intent under `.spark` artifacts
- `spark-cli`
   - native Spark-first `pi-tui` host with explicit builtin extension loading, provider registry, model selector, JSONL session store, skill resolver, local daemon queue, and `SparkAgentLoop`
   - extension packages depend on `pi-extension-api`, not on Pi's concrete SDK runtime

## Boundary guard status

- `pi-* -> spark-*` imports/dependencies are forbidden.
- `scripts/check-pi-boundaries.mjs` scans `packages/pi-*` manifests and source imports for `spark-*` regressions.
- `pnpm run check:boundaries` is wired into `prek.toml` as `pi-boundary-check`; CI static checks run `prek`, so the guard runs in CI.
- The guard intentionally checks dependency/import boundaries, not arbitrary historical strings; on-disk/schema compatibility strings such as goal continuation markers remain allowed.

## Current public tool surface

- `task({ action })` owns project/task/TODO/run/status/cache-cleanup actions.
- `goal({ action })` owns Spark session-bound goal actions.
- `artifact({ action })` owns evidence/artifact records.
- `learning({ action })` owns evidence-backed reusable learnings.
- `ask({ action })` owns user-question UX and result semantics.
- `context({ action })`, `recall`, `workflow({ action })`, `role({ action })`, `pi-cue`, and `pi-graft` tools remain canonical generic surfaces; patcher-style child runs belong to `graft_patch`, not the Spark facade.
- Public/default action tools render as `tool action=<value> ...`; do not keep fragmented compatibility surfaces public when a canonical action tool owns the domain.

## Deferred by design

- `spark-github`
- full autonomous scheduler daemon beyond the current local Spark daemon queue
- production-grade non-Pi child role executor
- worktree/merge/release gates
- optional micro-splitting of large implementation files that no longer block package boundary correctness
