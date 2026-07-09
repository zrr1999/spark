# Spark package boundaries

Spark-owned capability packages use `spark-*` names for the reusable mechanism layer.
Public tool names stay stable (`artifact`, `ask`, `task_read`, `task_write`, `assign`,
`workflow`, `goal`, `loop`, etc.), and historical serialized strings under `.spark/`
remain schema data rather than package-ownership markers.

## Dependency rules

- `spark-*` capability packages are the reusable Spark mechanism layer and must not
  depend on app-specific Spark/Cockpit/daemon adapters.
- Remaining `pi-*` packages are retained Pi-compatible adapters or not-yet-renamed
  capabilities. They may depend only on renamed Spark foundation packages
  (`spark-extension-api`, `spark-artifacts`, `spark-tasks`, `spark-workflows`,
  `spark-loop`, `spark-modes`, `spark-host`) and the explicit `@zendev-lab/spark-tui`
  / `@zendev-lab/spark-text` presentation boundary; they must not depend on Spark
  product packages.
- `pi-btw` is explicitly out of scope for the current rename wave.
- Historical serialized strings under `.spark/` are on-disk schema data, not package
  ownership. Keep `.spark/`, `.spark/projects.json`, `.spark/workflow-runs.json`, and
  historical loop/goal custom-entry marker values stable unless an explicit migration
  is planned.

`scripts/check-pi-boundaries.mjs` enforces these rules across package manifests and
source imports. Root `pnpm run check`, local `prek` hooks, and CI static checks run
the boundary checker.

## Dependency direction

```text
spark-extension-api   # host/tool contracts, refs, light fs/json/time helpers
spark-protocol        # daemon/server protocol schemas, state-ownership constants, fixtures

spark-artifacts       # artifact/evidence store and canonical artifact tool
spark-loop            # generic loop/goal primitives plus session goal/loop stores
spark-modes           # generic per-turn mode/lens primitives
spark-tasks           # generic project/task/TODO graph, readiness, claims, task_read/task_write/assign tools
spark-workflows       # saved workflow discovery/runtime primitives and DAG run store

spark-ask             # canonical ask tool plus shared focused/flow UI semantics
spark-context         # bounded registered context providers
spark-cue             # cue-shell execution tools
spark-files           # local file/search tools
spark-graft           # graft patch/candidate tools
spark-learnings       # evidence-backed learning records, reflection pipeline, and learning tool
spark-memory          # unified explicit memory store/search/policy layer
spark-web             # native web_search/fetch_content/get_search_content capability
spark-recall          # explicit lightweight recall candidates
spark-roles           # reusable role specs and simple role-run helpers
pi-btw                # Pi-specific side-conversation workflow, excluded from this rename wave

spark-ai              # model-routing contracts, provider registry compatibility, pi-ai bridge
spark-text            # text/markdown presentation helpers behind spark-tui
spark-tui             # reusable TUI presentation boundary (only package that may import pi-tui directly)
spark-i18n            # shared CLI/extension localization helpers

spark-runtime         # Spark task-to-role-run adapter and role-run artifacts
spark-host            # shared Spark ExtensionAPI host runtime and keybindings
spark-turn            # shared model/tool turn loop and view-event projection
pi-extension          # Pi-compatible facade (legacy): modes, widget, commands, builtin Spark roles, policy

spark-db              # SQLite migrations, client helpers, and dialect for Cockpit projection store
spark-server          # Cockpit coordination/query plane over spark-db
spark-system          # XDG paths, private dirs/files, daemon state paths

apps/spark-cli        # thin root spark dispatcher
apps/spark-tui        # native Spark TUI app/bootstrap over spark-host + spark-turn
apps/spark-daemon     # local daemon/queue app using Spark headless session execution
apps/spark-cockpit    # SvelteKit web cockpit; routes call spark-server, not spark-db or .spark stores directly
```

Allowed high-level usage:

- `pi-extension` may orchestrate Spark mode UI/policy and compose capability primitives
  plus `spark-runtime`. It owns ordinary lightweight research behavior, intent-specific
  Spark commands such as `/plan`, `/implement`, `/goal`, `/loop`, `/workflow`, the Spark
  widget, active-context provider registration, and use of the three audited builtin role
  specs (`scout`, `reviewer`, `worker`).
- `spark-runtime` adapts one Spark task into a `spark-roles` role run and maps completion
  back into task status, claims, and artifacts.
- `spark-host` owns the reusable Spark-native ExtensionAPI host runtime: tool/command
  registries, event bus, interaction/outbox plumbing, keybindings, and host-neutral
  runtime types.
- `spark-turn` owns the reusable Spark-native model/tool turn loop: model stream
  orchestration, tool roundtrips, approvals, aborts, outbox draining, and view-event
  projection.
- `spark-tasks` owns durable project/task/TODO graph state, readiness rules, task/run
  types, claim leases, and the canonical `task({ action })` tool. Optional task
  `roleRef` values are executor hints, not readiness requirements.
- `spark-workflows` owns saved workflow discovery/runtime primitives and
  `.spark/workflow-runs.json` DAG/workflow-run state. Workflow is the generic superset;
  DAG runs are workflow runs.
- `spark-loop` owns generic loop/goal primitives and session goal/loop stores while
  Spark owns project-bound `/loop` and `/goal` command/facade behavior. Historical
  loop/goal entry marker strings remain stable until an explicit migration changes them.
- `spark-artifacts` owns artifact metadata/blobs and the canonical `artifact({ action })`
  tool. Generative UI payloads are artifact-backed data/AST, not executable MDX/JS/JSX.
- `spark-learnings` owns `.learnings/` evidence-backed learning records, the deterministic
  reflection candidate/scanner/synthesis pipeline, and the canonical `learning({ action })`
  tool while delegating artifact persistence to `spark-artifacts`.
- `spark-ask` owns ask protocol/UI/result semantics and the canonical public/default
  `ask({ action })` tool. Focused and flow implementations are internal dispatch targets
  behind that surface. Spark asks must be context-specific; no canned intake forms.
- `spark-memory` provides the unified explicit memory direction over scoped entries while
  keeping `learning` and `recall` as stable public compatibility surfaces.
  `spark-context`, `spark-recall`, and `spark-learnings` remain separate capabilities:
  current bounded context, explicit recall candidates, and evidence-backed reusable
  learnings.
- `spark-server` owns server coordination, projection queries, artifact preview/cache helpers, and workspace route data. `apps/spark-cockpit` is the Cockpit web UI host (launch via `spark cockpit`); it mounts `spark-server` instead of importing `spark-db` or local workspace `.spark` stores outside its `src/lib/server` boundary.
- `apps/spark-daemon` is execution truth and local arbitration. Local RPC, runtime
  WebSocket/server uplink, queues, locks, dispatch policy, and headless `session.run`
  enter the daemon dispatcher; transports must not bypass it.
- `RoleSpec` objects are definition-layer objects; runtime launch mode is `fresh | forked`.
  Do not expose legacy `managed` as a runtime-facing mode or primary source.

Forbidden dependencies:

```text
pi-* -> spark product packages      # allowed only for renamed Spark foundation packages and spark-tui/spark-text
spark core -> cockpit/daemon apps
spark-tasks -> spark-roles
spark-tasks -> spark-runtime
spark-tasks -> spark-workflows
cockpit packages -> spark-cli / spark-tui-app host internals
```

`apps/spark-tui/src/host/agent-loop.ts`, `runtime.ts`, `types.ts`, and `keybindings.ts`
are compatibility adapters; shared implementation belongs in `packages/spark-turn` and
`packages/spark-host`.

## Public mental model

- Users know intent-specific Spark commands plus canonical tools.
- Durable project/task inspection uses `task_read({ action: ... })`; durable project/task
  mutation uses `task_write({ action: ... })`.
- Background ready-task execution is `assign({ dryRun: true })`; run inspection is
  `task_read({ action: "run_status" })`, while public `run_control` is not part of the
  default model-facing surface.
- Evidence is `artifact({ action: ... })`.
- Reusable learnings are `learning({ action: ... })`.
- User decisions are `ask({ action: "ask" | "flow" })`.
- Saved workflow discovery is `workflow({ action: ... })`; Spark commands decide when/how
  to execute workflow policy.
- Execution shell integration is `spark-cue`.
- Review gates remain Spark initialization/review-flow data, not a separate package
  boundary.

`subagents` is not a public product concept in this repo; the Spark-side concrete child
execution term is `role-run`.

## Related architecture docs

- [`hosts.md`](./hosts.md) — Pi host, native TUI host, and daemon execution/transport boundaries.
- [`daemon.md`](./daemon.md) — daemon execution-plane reference for lock, queue, local IPC, and cockpit transport adapters.
- [`cockpit-projection.md`](./cockpit-projection.md) — Cockpit SQLite projection vs Spark execution truth.
- [`capabilities-ui.md`](./capabilities-ui.md) — capability naming plus artifact-backed Generative UI direction.
