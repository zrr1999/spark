# Spark Package Architecture

Spark-owned capability packages use `spark-*` names for the core mechanism layer.
Public tool names stay stable (`artifact`, `ask`, `task_read`, `task_write`,
`assign`, `workflow`, `goal`, `loop`, etc.), and historical serialized strings
under `.spark/` remain schema data rather than package-ownership markers.

## Current dependency rule

- `spark-*` capability packages are the reusable Spark mechanism layer and must
  not depend on app-specific Spark/Cockpit/daemon adapters.
- Remaining `pi-*` packages are retained Pi-compatible adapters or not-yet-renamed
  capabilities. They may depend only on the renamed Spark foundation packages
  (`spark-extension-api`, `spark-artifacts`, `spark-tasks`, `spark-workflows`,
  `spark-loop`, `spark-modes`) and the explicit `@zendev-lab/spark-tui`
  presentation boundary; they must not depend on Spark product packages.
- `pi-btw` is explicitly out of scope for the current rename wave.
- Historical serialized strings under `.spark/` are on-disk schema data, not
  package ownership. Keep `.spark/`, `.spark/projects.json`,
  `.spark/workflow-runs.json`, and historical loop/goal custom-entry marker
  values stable unless an explicit migration is planned.

## Dependency direction

```text
spark-extension-api   # host/tool contracts, refs, light fs/json/time helpers

spark-artifacts       # artifact/evidence store and canonical artifact tool
spark-loop            # generic loop and durable goal state/prompt primitives
spark-modes           # generic per-turn mode/lens primitives
spark-tasks           # generic project/task/TODO graph, readiness, claims, task_read/task_write/assign tools
spark-workflows       # saved workflow discovery/runtime primitives and DAG run store

spark-ask                # canonical ask tool plus shared focused/flow UI semantics
spark-context            # bounded registered context providers
spark-cue                # cue-shell execution tools
spark-files              # local file/search tools
spark-graft              # graft patch/candidate tools
spark-learnings          # evidence-backed local learning records and learning tool
spark-recall             # explicit lightweight recall candidates
spark-roles              # reusable role specs and simple role-run helpers
pi-btw                # Pi-specific side-conversation workflow, excluded from this rename wave

spark-runtime         # Spark task-to-role-run adapter and role-run artifacts
spark-host            # shared Spark ExtensionAPI host runtime and keybindings
spark-turn            # shared model/tool turn loop and view-event projection
spark-extension       # Spark facade: modes, widget, commands, builtin Spark roles, policy
spark-cli             # thin root spark dispatcher
spark-tui-app         # native Spark TUI app/bootstrap over spark-host + spark-turn
spark-daemon          # local daemon/queue app using Spark headless session execution
```

Allowed high-level usage:

- `spark-extension` may orchestrate Spark mode UI/policy and compose capability
  primitives plus `spark-runtime`. It owns ordinary lightweight research
  behavior, intent-specific Spark commands such as `/plan`, `/implement`,
  `/goal`, `/loop`, `/workflow`, the Spark widget, active-context provider
  registration, and use of the three audited builtin role specs (`scout`,
  `reviewer`, `worker`).
- `spark-runtime` adapts one Spark task into a `spark-roles` role run and maps
  completion back into task status, claims, and artifacts.
- `spark-host` owns the reusable Spark-native ExtensionAPI host runtime:
  tool/command registries, event bus, interaction/outbox plumbing, keybindings,
  and host-neutral runtime types.
- `spark-turn` owns the reusable Spark-native model/tool turn loop: model stream
  orchestration, tool roundtrips, approvals, aborts, outbox draining, and
  view-event projection.
- `spark-tasks` owns durable project/task/TODO graph state, readiness rules,
  task/run types, claim leases, and the canonical `task({ action })` tool.
  Optional task `roleRef` values are executor hints, not readiness requirements.
- `spark-workflows` owns saved workflow discovery/runtime primitives and
  `.spark/workflow-runs.json` DAG/workflow-run state. Workflow is the generic
  superset; DAG runs are workflow runs.
- `spark-loop` owns generic loop and goal primitives while Spark owns
  project-bound `/loop` and `/goal` command/facade behavior. Historical loop/goal
  entry marker strings remain stable until an explicit migration changes them.
- `spark-artifacts` owns artifact metadata/blobs and the canonical
  `artifact({ action })` tool.
- `spark-learnings` owns `.learnings/` evidence-backed learning records and the
  canonical `learning({ action })` tool while delegating artifact persistence to
  `spark-artifacts`.
- `spark-ask` owns ask protocol/UI/result semantics and the canonical public/default
  `ask({ action })` tool. Focused and flow implementations are internal dispatch
  targets behind that surface. Spark asks must be context-specific; no canned
  intake forms.
- `spark-context`, `spark-recall`, and `spark-learnings` are separate capabilities:
  current bounded context, explicit recall candidates, and evidence-backed
  reusable learnings.
- `RoleSpec` objects are definition-layer objects; runtime launch mode is
  `fresh | forked`. Do not expose legacy `managed` as a runtime-facing mode or
  primary source.

Forbidden dependencies:

```text
pi-* -> spark product packages      # allowed only for renamed Spark foundation packages and @zendev-lab/spark-tui
spark core -> cockpit/daemon apps
spark-tasks -> spark-roles
spark-tasks -> spark-runtime
spark-tasks -> spark-workflows
```

The root `pnpm run check` gate, a local `prek` hook, and CI static checks run
the boundary checker, which scans package manifests and source imports for these
regressions. `apps/spark-tui/src/host/agent-loop.ts`, `runtime.ts`, `types.ts`,
and `keybindings.ts` are compatibility adapters; shared implementation belongs
in `packages/spark-turn` and `packages/spark-host`.

## Public mental model

- Users know intent-specific Spark commands plus canonical tools.
- Durable project/task inspection uses `task_read({ action: ... })`; durable
  project/task mutation uses `task_write({ action: ... })`.
- Background ready-task execution is `assign({ dryRun: true })`; run inspection
  is `task_read({ action: "run_status" })`, while public `run_control` is not
  part of the default model-facing surface.
- Evidence is `artifact({ action: ... })`.
- Reusable learnings are `learning({ action: ... })`.
- User decisions are `ask({ action: "ask" | "flow" })`.
- Saved workflow discovery is `workflow({ action: ... })`; Spark commands decide
  when/how to execute workflow policy.
- Execution shell integration is `spark-cue`.
- Review gates remain Spark initialization/review-flow data, not a separate
  package boundary.

`subagents` is not a public product concept in this repo; the Spark-side
concrete child execution term is `role-run`.
