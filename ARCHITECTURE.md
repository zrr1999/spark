# Spark Package Architecture

## Naming rule

Use the dependency boundary as the naming boundary:

- `pi-*` packages are reusable Pi infrastructure primitives and must not depend on `spark-*` packages, except for the explicit `@zendev-lab/spark-tui` presentation boundary used by shared UI renderers.
- `spark-*` packages are Spark facade/runtime policy packages and may compose `pi-*` primitives.
- Historical serialized strings under `.spark/` are on-disk schema data, not package ownership. Keep `.spark/`, `.spark/projects.json`, `.spark/workflow-runs.json`, and the historical goal custom-entry marker values stable unless an explicit migration is planned.

`pi-cue`, `pi-ask`, `pi-roles`, `pi-tasks`, `pi-learnings`, `pi-loop`, `pi-workflows`, `pi-artifacts`, `pi-context`, and `pi-recall` are infrastructure, not Spark-specific workflow logic. Future generic packages should follow the same rule.

## Dependency direction

```text
pi-extension-api       # host/tool contracts, refs, light fs/json/time helpers

pi-artifacts           # artifact/evidence store and canonical artifact tool
pi-ask                 # canonical ask tool plus shared focused/flow UI semantics
pi-context             # bounded registered context providers
pi-cue                 # cue-shell execution tools
pi-loop                # generic loop and durable goal state/prompt primitives
pi-learnings           # evidence-backed local learning records and learning tool
pi-recall              # explicit lightweight recall candidates
pi-roles               # reusable role specs and simple role-run helpers
pi-tasks               # generic project/task/TODO graph, readiness, claims, task_read/task_write/assign tools
pi-workflows           # saved workflow discovery/runtime primitives and DAG run store

spark-runtime          # Spark task-to-role-run adapter and role-run artifacts
spark-host             # shared Spark ExtensionAPI host runtime and keybindings
spark-turn             # shared model/tool turn loop and view-event projection
spark-extension        # Spark facade: modes, widget, commands, builtin Spark roles, policy
spark-cli              # thin root spark dispatcher
spark-tui-app          # native Spark TUI app/bootstrap over spark-host + spark-turn
spark-daemon           # local daemon/queue app using Spark headless session execution
```

Allowed high-level usage:

- `spark` may orchestrate Spark mode UI/policy and compose `pi-*` capabilities plus `spark-runtime`. It owns ordinary lightweight research behavior, intent-specific Spark commands such as `/plan`, `/implement`, `/goal`, `/loop`, `/workflow`, the Spark widget, active-context provider registration, and use of the three audited builtin role specs (`scout`, `reviewer`, `worker`).
- `spark-runtime` adapts one Spark task into a `pi-roles` role run and maps completion back into task status, claims, and artifacts.
- `spark-host` owns the reusable Spark-native ExtensionAPI host runtime: tool/command registries, event bus, interaction/outbox plumbing, keybindings, and host-neutral runtime types.
- `spark-turn` owns the reusable Spark-native model/tool turn loop: model stream orchestration, tool roundtrips, approvals, aborts, outbox draining, and view-event projection.
- `pi-tasks` owns durable project/task/TODO graph state, readiness rules, task/run types, claim leases, and the canonical `task({ action })` tool. Optional task `roleRef` values are executor hints, not readiness requirements.
- `pi-workflows` owns saved workflow discovery/runtime primitives and `.spark/workflow-runs.json` DAG/workflow-run state. Workflow is the generic superset; DAG runs are workflow runs.
- `pi-loop` owns generic loop and goal primitives while Spark owns project-bound `/loop` and `/goal` command/facade behavior. Historical loop/goal entry marker strings remain stable until an explicit migration changes them.
- `pi-learnings` owns `.learnings/` evidence-backed learning records and the canonical `learning({ action })` tool.
- `pi-artifacts` owns artifact metadata/blobs and the canonical `artifact({ action })` tool.
- `pi-ask` owns ask protocol/UI/result semantics and the canonical public/default `ask({ action })` tool. Focused and flow implementations are internal dispatch targets behind that surface. Spark asks must be context-specific; no canned intake forms.
- `pi-context`, `pi-recall`, and `pi-learnings` are separate capabilities: current bounded context, explicit recall candidates, and evidence-backed reusable learnings.
- `RoleSpec` objects are definition-layer objects; runtime launch mode is `fresh | forked`. Do not expose legacy `managed` as a runtime-facing mode or primary source.

Forbidden dependencies:

```text
pi-* -> spark-*              # except @zendev-lab/spark-tui UI boundary
pi-tasks -> pi-roles
pi-tasks -> spark-runtime
pi-tasks -> pi-workflows
```

The root `pnpm run check` gate, a local `prek` hook, and CI static checks run the boundary checker, which scans `packages/pi-*` manifests and source imports for `spark-*` regressions while allowing only the `@zendev-lab/spark-tui` UI-boundary exception. `apps/spark-tui/src/host/agent-loop.ts`, `runtime.ts`, `types.ts`, and `keybindings.ts` are compatibility adapters; shared implementation belongs in `packages/spark-turn` and `packages/spark-host`.

## Public mental model

- Users know intent-specific Spark commands plus canonical tools.
- Durable project/task inspection uses `task_read({ action: ... })`; durable project/task mutation uses `task_write({ action: ... })`.
- Background ready-task execution is `assign({ dryRun: true })`; run inspection is `task_read({ action: "run_status" })`, while public `run_control` is not part of the default model-facing surface.
- Evidence is `artifact({ action: ... })`.
- Reusable learnings are `learning({ action: ... })`.
- User decisions are `ask({ action: "ask" | "flow" })`.
- Saved workflow discovery is `workflow({ action: ... })`; Spark commands decide when/how to execute workflow policy.
- Execution shell integration is `pi-cue`.
- Review gates remain Spark initialization/review-flow data, not a separate package boundary.

`subagents` is not a public product concept in this repo; the Spark-side concrete child execution term is `role-run`.
