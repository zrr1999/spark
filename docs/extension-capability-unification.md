# Extension capability unification migration record

This historical migration record documents the implemented contract for making the Pi/Spark extension suite conceptually unified while keeping implementations decoupled. It is intentionally **extension-first**: it does not refactor `packages/spark-cli/src/host/*` or native Spark CLI session internals.

## Status (2026-06-05)

This migration is implemented for package boundaries and the visible tool facade:

- `spark-core`, `spark-tasks`, `spark-learnings`, `spark-goal`, and `spark-workflows` have retired as workspaces.
- Generic implementations now live in `pi-extension-api`, `pi-artifacts`, `pi-tasks`, `pi-learnings`, `pi-goal`, and `pi-workflows`.
- Spark's visible tool surface uses canonical tools (`task_read`, `task_write`, `assign`, `learning`, `artifact`, `ask`, `context`, `workflow`, `role`, `recall`, `goal`). Legacy `spark_*` tool configs are internal implementation wiring only and are not registered as active tools.
- `pi-* -> spark-*` regressions are guarded by `pnpm run check:boundaries`, `prek`, and CI static checks.
- On-disk schema roots remain stable: `.spark/`, `.spark/projects/`, `.spark/workflow-runs.json`, and historical goal marker strings are compatibility data, not package ownership; legacy `.spark/projects.json` is import-only.

## Goals

- Promote reusable capabilities to `pi-*` packages when they are not Spark-specific.
- Keep Spark as a mode/facade that composes reusable Pi capabilities for project/goal workflows.
- Remove duplicate or worse user-facing tool surfaces instead of keeping long-lived compatibility aliases.
- Keep tool behavior controlled: strict schemas, provenance, state machines, review queues, and bounded context budgets.
- Preserve clear ownership boundaries so implementation packages are decoupled even when the user experience is unified.

## Non-goals

- No new generic `core`, `kit`, or shared dumping-ground package.
- No Spark CLI native host refactor in this workstream.
- No migration of existing local `.learnings/` or memory stores unless explicitly requested.
- No arbitrary workflow execution, arbitrary system-prompt injection, or arbitrary metadata patch surface.
- No automatic promotion of side-thread/web/recall output into task evidence or durable learning.

## Design rules

### 1. One user concept has one canonical surface

Canonical agent-facing tools should be named by concept and use an `action`/`mode` discriminator when the operations share one state model:

- `task(...)`
- `artifact(...)`
- `ask(...)`
- `role(...)`
- `learning(...)`
- `context(...)`
- `recall(...)`
- `workflow(...)`

Existing split tools such as `spark_update_todos`, `spark_ask`, `spark_learning_search`, and `list_roles` are replaced by the canonical owner. They are not kept as long-term aliases.

Domain-specific command families that are not duplicated by Spark, such as `pi-cue` and `pi-graft`, are not forced into one giant tool in this pass. Their explicit tools currently provide stricter per-action schemas for execution and patch/scratch operations. They should still adopt the common result envelope/rendering guidance below, and a later pass may collapse them only if a discriminated schema remains at least as safe and understandable.

### 2. Capability packages own mechanisms; Spark owns policy

Spark should not own generic mechanisms. It should provide:

- Spark compatibility entry plus `/research`, `/plan`, `/implement`, `/goal`, `/workflow` commands.
- Spark research-default mode prompt and activation rules.
- Spark context providers over active project/task/workflow state.
- Spark function/workflow presets and orchestration policy.

The reusable capabilities own the tools and storage mechanisms.

### 3. No freeform mutation holes

Mutating actions must not accept open-ended `patch`, `metadata`, `systemPrompt`, or `context` blobs unless the field is the actual domain object being created and is guarded by schema/readiness checks. Every write needs:

- a concrete action;
- a strict schema;
- provenance or scope;
- dry-run by default when destructive or broad;
- structured warnings and next actions;
- typed owner APIs rather than direct unstructured JSON writes.

### 4. Common tool result envelope

Every canonical tool should return a consistent shape:

```ts
{
  content: [{ type: "text", text: summary }],
  details: {
    tool: "task" | "artifact" | "ask" | "role" | "learning" | "context" | "recall" | "workflow",
    action: string,
    refs?: Record<string, string | string[]>,
    changed?: boolean,
    dryRun?: boolean,
    warnings?: Array<{ code: string; message: string; ref?: string }>,
    nextActions?: Array<{ label: string; tool: string; params: Record<string, unknown> }>,
    provenance?: Record<string, unknown>
  }
}
```

The text summary stays compact. Full structured data lives in `details` or artifacts.

## Current ownership findings

| Current area           | Evidence                                                                                         | Current owner                    | Finding                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Host contract          | `packages/pi-extension-api/src/index.ts`                                                         | `pi-extension-api`               | Host/tool contract plus shared refs and light helpers.                                                                                   |
| Role specs/runs        | `packages/pi-roles/src/extension.ts`, `docs/role-boundaries.md`                                  | `pi-roles`                       | Generic reusable role ownership is correct; Spark role execution goes through task/run policy.                                           |
| Ask UI                 | `packages/pi-ask/src/index.ts`, `packages/pi-ask/src/flow.ts`                                    | `pi-ask`                         | Generic ask UI/result semantics are exposed through canonical `ask`; focused/flow implementations are internal.                          |
| Artifacts              | `packages/pi-artifacts/src/index.ts`, `packages/pi-artifacts/src/extension.ts`                   | `pi-artifacts`                   | Artifact store is generic evidence infrastructure, not Spark-specific.                                                                   |
| Task graph/TODO/run    | `packages/pi-tasks/src/*`, `packages/spark/src/extension/index.ts` action handlers               | `pi-tasks` + Spark facade        | TODO belongs to task state; project/task/TODO/run are split into `task_read`, `task_write`, and explicit `assign` capability surfaces.      |
| Learnings              | `packages/pi-learnings/src/*`                                                                    | `pi-learnings`                   | Evidence-backed learning is generic; plural `.learnings/` is retained.                                                                   |
| Active context         | `packages/pi-context/src/extension.ts`, `packages/spark/src/extension/spark-active-context.ts`   | `pi-context` + Spark provider    | Spark registers a bounded `spark.active` provider.                                                                                       |
| Recall/memory          | `packages/pi-recall/src/index.ts`                                                                | `pi-recall`                      | Lightweight explicit recall is separate from `pi-learnings`.                                                                             |
| Workflow saved scripts | `packages/pi-workflows/src/*`, `packages/spark/src/extension/spark-workflow-registry.ts`         | `pi-workflows` + Spark facade    | Saved scripts and workflow-run state are reusable Pi workflow capability; Spark `/workflow` delegates policy.                            |
| Spark state cleanup    | `packages/spark/src/extension/spark-state-tool-registration.ts`, `docs/spark-store-inventory.md` | Spark facade + individual stores | Split broad cleanup into owner-specific maintenance actions. Avoid one broad unrestricted state cleanup tool.                            |
| Pi-only side thread    | `packages/pi-btw/`                                                                               | `pi-btw`                         | Keep Pi-host-only. Do not add to native Spark CLI defaults or auto-ingest hidden side threads into main context.                         |
| Cue/Graft              | `packages/pi-cue`, `packages/pi-graft`                                                           | `pi-cue`, `pi-graft`             | Domain-specific explicit tool families are not duplicated by Spark. Keep out of this pass except common envelope/rendering improvements. |

## Target packages

### `pi-extension-api`

Keep as the host contract/type package only. It may grow only when both Pi host and Spark native host intentionally support a capability. It must not gain artifact/task/ask/reload business logic.

### `pi-artifacts`

Own content-addressed evidence storage and artifact tools.

Exports:

- `ArtifactStore`
- `Artifact`, `ArtifactRef`, `ArtifactLink`, `Provenance`
- `defaultArtifactStore(cwd)` or configurable store factory
- body blob helpers and bounded preview helpers

Canonical tool:

```ts
artifact({ action: "record" | "list" | "read" | "link" | "compact", ... })
```

Actions:

| Action    | Required inputs                                                          | Controlled behavior                                                       | Replaces / borrows from                               |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `record`  | `kind`, `title`, `format`, `body`, `provenance`, optional `links`        | writes blob then metadata; metadata is commit point; validates provenance | `ArtifactStore.put()`                                 |
| `list`    | optional `kind`, `producer`, `projectRef`, `taskRef`, `roleRef`, `limit` | bounded newest-first listing                                              | `spark_list_artifacts`                                |
| `read`    | `artifactRef`, optional `full`, `maxChars`                               | default truncated body; full read explicit                                | `spark_get_artifact`, `get_search_content` pattern    |
| `link`    | `from`, `to`, `relation`                                                 | typed relation only; no arbitrary graph edges                             | current `ArtifactLink`                                |
| `compact` | strategy-specific options, `dryRun` default true                         | owner-specific retention only; no generic deletion                        | role-run retention, `context-mode` storage discipline |

### `pi-tasks`

Own project/task/TODO/run graph state. Package name may be plural for grouping, but the public/default tools are split by capability: `task_read`, `task_write`, and `assign`.

Exports live in `pi-tasks` after promotion:

- project/task/run/TODO types;
- `TaskGraphStore`;
- `TaskTodoStore`;
- readiness/state-machine helpers.

Canonical tools:

```ts
task_read({ action: "status" | "project_list" | "run_status", ... })
task_write({ action: "project_use" | "project_update" | "claim" | "plan" | "finish" | "todo_update" | "cache_cleanup", ... })
assign({ dryRun?: boolean, maxConcurrency?: number, timeoutMs?: number })
```

Actions:

| Surface/action                | Required inputs                                                 | Controlled behavior                                                | Replaces / borrows from                                      |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `task_read.status`            | optional `view`, `limit`, `format`                              | active view by default, bounded output                             | `spark_status`                                               |
| `task_read.project_list`      | optional status filter                                          | read-only                                                          | `spark_list_projects`                                        |
| `task_read.run_status`        | run/task/project selectors                                      | read/reconcile status                                              | `spark_background_runs`, `spark_dag_manager status`          |
| `task_write.project_use`      | existing selector or creation input                             | session-scoped selection; project creation through graph API       | `spark_use_project`                                          |
| `task_write.project_update`   | project selector + explicit changed fields                      | no arbitrary patch                                                 | `spark_rename_project`                                       |
| `task_write.claim`            | stable task identity + plan metadata when creating/updating     | one unfinished claim per session                                   | `spark_claim_task`                                           |
| `task_write.plan`             | concrete tasks with plan/readiness fields                       | blocks open questions and missing evidence/steps                   | `spark_plan_tasks`                                           |
| `task_write.finish`           | claimed task + terminal status + summary                        | completion evidence check remains enforced                         | `spark_finish_task`                                          |
| `task_write.todo_update`      | `scope: "session" \| "task"`, ops array, optional task selector | task scope requires a current claimed task unless explicit owner   | `spark_update_todos`, `spark_update_task_todos`, `rpiv-todo` |
| `task_write.cache_cleanup`    | `dryRun` default true, staleness options                        | only task-owned/session TODO caches; protected graph never deleted | safe subset of `spark_state cleanup`                         |
| `assign`                     | dryRun default true, concurrency/timeout                        | explicit ready-frontier scheduling/spawn surface                   | `spark_run_ready_tasks`, workflow runtime async UX           |

TODO is not a separate package or tool. It is a sub-action of the canonical task-write capability.

### `pi-ask`

Own all user-question UI and persisted ask answers.

Canonical tool:

```ts
ask({ mode: "clarification" | "decision" | "approval" | "unblock", action?: "ask" | "replay" | "list", questions?, provenance?, persistence? })
```

Actions/modes:

| Surface                                   | Behavior                                 | Replaces / borrows from                       |
| ----------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| `ask` with one question                   | uses single-question UI when appropriate | internal focused implementation               |
| `ask` with multiple questions or previews | uses flow/fullscreen UI                  | internal flow implementation, old `spark_ask` |
| `replay`                                  | replays latest/specified persisted ask   | `spark_ask_replay`                            |
| `list`                                    | read-only persisted ask listing, bounded | artifact-backed ask history                   |

UI improvements to absorb:

- submit review tab and option notes from `@juicesharp/rpiv-ask-user-question`;
- searchable split-pane and inline/overlay option from `pi-ask-user`;
- existing `pi-ask` flow preview height fix.

Spark-specific ask persistence becomes an adapter/provenance option in `pi-ask`, not a separate `spark_ask` concept.

### `pi-roles`

Keep ownership of reusable `RoleSpec` and concrete `RoleRun`. Consolidate tool surface.

Canonical tool:

```ts
role({ action: "list" | "get" | "create" | "call", ... })
```

Actions:

| Action   | Required inputs                                                | Controlled behavior                                                                        | Replaces      |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| `list`   | optional source/includeUser/limit                              | read-only                                                                                  | `list_roles`  |
| `get`    | role selector                                                  | include prompt only when explicit                                                          | `get_role`    |
| `create` | id, description, systemPrompt, rationale, expectedUses, source | no anonymous role; writable source project/user only                                       | `create_role` |
| `call`   | role, instruction, `mode: fresh \| forked`                     | explicit fork source when forked; Spark mode still prefers `assign({ dryRun: true })` | `call_role`   |

### `pi-learnings`

Own evidence-backed reusable learning records and `.learnings/` storage.

Canonical tool:

```ts
learning({ action: "record" | "search" | "list" | "read" | "mark_stale" | "supersede" | "reject" | "export_markdown" | "import_markdown", ... })
```

Actions are implemented directly by `pi-learnings` and exposed through the canonical `learning` tool. Guardrails:

- `.learnings/` remains plural and local-only by default.
- `record` requires a reusable statement and evidence refs or a candidate status.
- Auto-discovered learning should default to candidate, not active.
- Learning is not lightweight memory; do not use it for daily notes or transient preferences.

### `pi-context`

Own context provider registration, preview, handoff, and reinjection.

Canonical tool:

```ts
context({ action: "preview" | "status" | "handoff" | "reinject" | "cache_cleanup", ... })
```

Actions:

| Action          | Required inputs                                             | Controlled behavior                                                  | Replaces / borrows from                                                               |
| --------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `preview`       | optional reason/budget/provider filters                     | read-only generated bundle; no custom prompt text                    | current `renderActiveSparkContextSummary`, `pi-hermes-memory /memory-preview-context` |
| `status`        | optional detail level                                       | provider budgets, token estimates, skipped reasons                   | `context-mode ctx_stats`, `pi-lens /lens-health`                                      |
| `handoff`       | reason + typed summary fields or generated provider summary | writes artifact/recall candidate; no arbitrary system injection      | `pi-memory session_before_compact`, `gentle-engram mem_session_summary`               |
| `reinject`      | provider/budget/reason                                      | sends provider-generated hidden context only                         | current `spark-active-injection.ts`                                                   |
| `cache_cleanup` | dryRun default true                                         | session/context caches only; protected task/artifact stores excluded | safe subset of `spark_state cleanup`                                                  |

Provider contract:

```ts
interface ContextProvider {
   id: string;
   priority: number;
   defaultBudgetTokens: number;
   build(input: { cwd: string; reason: string; budgetTokens: number }): Promise<ContextSection[]>;
}
```

Spark registers a provider for active project/task/TODO/artifact/learning/workflow state. Hidden `pi-btw` entries are excluded unless explicitly selected by a future side-thread injection action.

### `pi-recall`

Own lightweight local memory/recall. It is deliberately separate from `pi-learnings`.

Canonical tool:

```ts
recall({ action: "record" | "search" | "read" | "forget" | "review", ... })
```

Actions:

| Action   | Required inputs                                | Controlled behavior                                       | Borrows from                                                      |
| -------- | ---------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `record` | scope, category, title/text, source/provenance | secret/private-block scan; auto records become candidates | `@samfp/pi-memory memory_remember`, `pi-hermes-memory memory add` |
| `search` | query, scope filter, limit                     | bounded snippets                                          | `memory_search`, `pi-memctx memctx_search`                        |
| `read`   | recall ref/id                                  | full record explicit                                      | `gentle-engram mem_get_observation`                               |
| `forget` | recall ref/id + reason                         | traceable tombstone preferred over silent delete          | `memory_forget`                                                   |
| `review` | candidate decisions                            | review queue workflow                                     | `pi-memctx /memctx-review`                                        |

Scopes must be explicit: `user | workspace | repo`. Recall is not task truth and not evidence. It can inform context, but it cannot satisfy task evidence requirements unless recorded as an artifact or learning with provenance.

### `pi-workflows`

Own saved scripts as a generic Pi capability.

Canonical tool:

```ts
workflow({ action: "list" | "read", ... })
```

Actions:

| Action        | Controlled behavior                                                | Replaces / borrows from                                         |
| ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `list`        | discovers only user/workspace saved script roots                   | `spark-workflow-registry`, `pi-prompt-template-model` discovery |
| `read`        | reads saved script metadata/body by selector                       | `pi-subagents chain get`                                        |
Execution and workflow-run retention remain host/Spark policy rather than public `workflow` tool mutations.

`/workflow` in Spark remains saved scripts only. `/goal` remains a separate Spark command and is not a workflow selector.

## Spark facade after cutover

`packages/spark` should register Spark commands and Spark-specific providers/policy only:

- Spark compatibility entry
- `/research`
- `/plan`
- `/implement`
- `/goal`
- `/workflow`
- Spark context provider registration
- Spark function/workflow presets over core roles
- Spark widget/mode rendering, backed by task graph data

It should not register duplicate canonical tools for task, artifact, ask, role, learning, context, recall, or workflow.

## Migration table

| Current tool/command                      | Canonical replacement                                                                              | Keep?              | Notes                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `spark_status`                            | `task_read({ action: "status" })` plus owner-specific status/context diagnostics                        | No long-term alias | Status rendering can stay shared internally.                            |
| `spark_list_projects`                     | `task_read({ action: "project_list" })`                                                                 | No                 | Generic task capability owns project lists.                             |
| `spark_use_project`                       | `task_write({ action: "project_use" })`                                                                  | No                 | Session-scoped selection remains.                                       |
| `spark_rename_project`                    | `task_write({ action: "project_update" })`                                                               | No                 | Rename/status/output language under explicit fields.                    |
| `spark_claim_task`                        | `task_write({ action: "claim" })`                                                                        | No                 | Preserve one-claim-per-session rule.                                    |
| `spark_plan_tasks`                        | `task_write({ action: "plan" })`                                                                         | No                 | Preserve readiness blocking rules.                                      |
| `spark_finish_task`                       | `task_write({ action: "finish" })`                                                                       | No                 | Preserve completion evidence requirement.                               |
| `spark_update_todos`                      | `task_write({ action: "todo_update", scope: "session" })`                                                | No                 | TODO belongs to task capability.                                        |
| `spark_update_task_todos`                 | `task_write({ action: "todo_update", scope: "task" })`                                                   | No                 | Task-bound TODO requires claimed task/selector.                         |
| `spark_run_ready_tasks`                   | `assign({ dryRun: true })`                                                                    | No                 | Spark role scheduling remains an adapter behind task capability.        |
| `spark_background_runs`                   | `task_read({ action: "run_status" })`                                                            | No                 | Read/reconcile status remains visible; public run_control is not default. |
| `spark_dag_manager`                       | `task_read({ action: "run_status" })` / internal workflow-run maintenance                         | No                 | Low-level compatibility/debug surface is not canonical.                 |
| `spark_state status/doctor`               | owner-specific status actions                                                                      | No                 | Avoid one broad state dumping ground.                                   |
| `spark_state cleanup`                     | `task_write({ action: "cache_cleanup" })` plus owner-specific cleanup actions                            | No                 | Owner-scoped dry-run cleanup only.                                      |
| `spark_state prune`                       | Spark workflow-run retention policy                                                                | No                 | Workflow-run store owner handles retention; not a public workflow tool action. |
| `spark_state compact-role-run-artifacts`  | `artifact({ action: "compact" })`                                                                  | No                 | Artifact owner handles blob retention.                                  |
| `spark_list_artifacts`                    | `artifact({ action: "list" })`                                                                     | No                 | Generic artifact capability.                                            |
| `spark_get_artifact`                      | `artifact({ action: "read" })`                                                                     | No                 | Generic artifact capability.                                            |
| `spark_ask`                               | `ask({ action: "ask", persistence: { artifact: true }, ... })`                                     | No                 | Pi ask owns UI and persistence adapter.                                 |
| `spark_ask_replay`                        | internal ask artifact read/replay helpers                                                           | No                 | Replay is not part of the public/default `ask` action surface.          |
| `ask_user`                                | `ask({ action: "ask", questions: [one] })`                                                         | Internal only      | Single-question implementation behind canonical `ask`.                  |
| `ask_flow`                                | `ask({ action: "flow", questions: [...] })`                                                        | Internal only      | Fullscreen/multi-question implementation behind canonical `ask`.        |
| `list_roles`                              | `role({ action: "list" })`                                                                         | Internal only      | Role listing implementation behind canonical `role`.                    |
| `get_role`                                | `role({ action: "get" })`                                                                          | Internal only      | Role inspection implementation behind canonical `role`.                 |
| `create_role`                             | `role({ action: "create" })`                                                                       | Internal only      | Role creation implementation behind canonical `role`.                   |
| `call_role`                               | `role({ action: "call" })`                                                                         | Internal only      | Direct one-off role implementation; Spark mode still prefers task runs. |
| `spark_learning_record`                   | `learning({ action: "record" })`                                                                   | No                 | Generic evidence-backed learning.                                       |
| `spark_learning_search`                   | `learning({ action: "search" })`                                                                   | No                 | Generic evidence-backed learning.                                       |
| `spark_learning_list`                     | `learning({ action: "list" })`                                                                     | No                 | Generic evidence-backed learning.                                       |
| `spark_learning_read`                     | `learning({ action: "read" })`                                                                     | No                 | Generic evidence-backed learning.                                       |
| `spark_learning_mark_stale`               | `learning({ action: "mark_stale" })`                                                               | No                 | Generic evidence-backed learning.                                       |
| `spark_learning_supersede`                | `learning({ action: "supersede" })`                                                                | No                 | Generic evidence-backed learning.                                       |
| `spark_learning_reject`                   | `learning({ action: "reject" })`                                                                   | No                 | Generic evidence-backed learning.                                       |
| `spark_learning_export_markdown`          | `learning({ action: "export_markdown" })`                                                          | No                 | Generic export.                                                         |
| `spark_learning_import_markdown`          | `learning({ action: "import_markdown" })`                                                          | No                 | Generic import.                                                         |
| Spark compatibility entry                   | Spark compatibility entry                                            | Yes                | Retained for existing callers; new guidance should prefer canonical tools and explicit mode commands. |
| `/research`, `/plan`, `/implement`, `/goal` | same                                                                 | Yes                | Spark mode commands.                                                    |
| `/workflow`                                 | `/workflow` through Spark host/runtime policy over saved workflows   | Yes                | Saved scripts only.                                                     |
| `/workflow:goal`                          | none                                                                                               | No                 | Goal is not workflow.                                                   |
| `cue_*`, `graft_*`                        | unchanged for this pass                                                                            | Yes                | Not duplicated Spark concepts; explicit schemas remain safer until a dedicated migration is designed. |

## Implementation order

1. **Contract and tests first.** Completed: this document records the migration contract and tests now assert canonical surfaces.
2. **Promote artifacts.** Completed: artifact store/tool live in `pi-artifacts`.
3. **Promote tasks.** Completed: `pi-tasks` owns project/task/TODO/run graph state; Spark registers canonical `task_read`, `task_write`, and `assign` handlers.
4. **Consolidate ask and role.** Completed for visible facade: `ask` and `role` are canonical action tools; Spark asks use shared `pi-ask` semantics.
5. **Promote learnings.** Completed: `pi-learnings` owns `.learnings/` semantics and the canonical `learning` tool.
6. **Add context and recall.** Completed: `pi-context` and `pi-recall` provide bounded context and explicit recall candidates.
7. **Promote workflows.** Completed: saved scripts and workflow-run state live in `pi-workflows`; `/goal` stays separate.
8. **Cut over Spark facade.** Completed: Spark's active tool registration exposes canonical tools; legacy `spark_*` configs are internal implementation wiring only.
9. **Review and cleanup.** In progress: final docs/status cleanup and optional micro-splits remain.

## Validation checklist

- `pnpm run check:tsc` passes.
- Focused tests for artifacts, tasks/TODOs, ask flow, roles, learnings, workflows, and Spark commands pass.
- Grep finds no canonical `spark_*` registrations for concepts owned by `pi-*` capabilities.
- Docs and skills direct agents to `task_read`, `task_write`, `assign`, `artifact`, `ask`, `role`, `learning`, `context`, `recall`, `workflow`, `pi-cue`, and `pi-graft` tools; patcher-style child runs use explicit extension roles.
- Mutating tools have strict schemas and provenance/scope.
- Broad cleanup/destructive actions default to dry-run and target only owner-approved stores.
- Automatic learning/recall writes enter candidate/review when evidence or user approval is absent.
- Context reinjection cannot pass arbitrary prompt text; it only composes registered providers under budget.
- Hidden side threads and web results are never automatically promoted to task evidence or learning.
