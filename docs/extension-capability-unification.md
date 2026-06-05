# Extension capability unification plan

This document is the migration contract for making the Pi/Spark extension suite conceptually unified while keeping implementations decoupled. It is intentionally **extension-first**: it does not refactor `packages/spark-cli/src/host/*` or native Spark CLI session internals.

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

- `/spark`, `/research`, `/plan`, `/execute`, `/goal`, `/workflow` commands.
- Spark mode prompt and activation rules.
- Spark context providers over active project/task/workflow state.
- Spark predefined roles and orchestration policy.

The reusable capabilities own the tools and storage mechanisms.

### 3. No freeform mutation holes

Mutating actions must not accept open-ended `patch`, `metadata`, `systemPrompt`, or `context` blobs unless the field is the actual domain object being created and is guarded by schema/readiness checks. Every write needs:

- a concrete action;
- a strict schema;
- provenance or scope;
- dry-run by default when destructive or broad;
- structured warnings and next actions;
- typed owner APIs rather than direct ad hoc JSON writes.

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

| Current area           | Evidence                                                                                                                                                                       | Current owner                          | Finding                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Host contract          | `packages/pi-extension-api/src/index.ts`                                                                                                                                       | `pi-extension-api`                     | Correctly host-only/type-only. Keep it narrow.                                                                                           |
| Role specs/runs        | `packages/pi-roles/src/extension.ts`, `docs/role-boundaries.md`                                                                                                                | `pi-roles`                             | Generic reusable role ownership is already correct; tool surface is fragmented (`list_roles`, `get_role`, `create_role`, `call_role`).   |
| Ask UI                 | `packages/pi-ask/src/index.ts`, `packages/pi-ask/src/flow.ts`                                                                                                                  | `pi-ask`                               | Generic ask UI exists, but Spark has separate persisted ask tools. Unify in `pi-ask`.                                                    |
| Artifacts              | `packages/spark-core/src/index.ts`, `packages/spark/src/extension/artifact-tool-registration.ts`                                                                               | currently `spark-core` + Spark facade  | Artifact store is generic evidence infrastructure, not Spark-specific. Promote to `pi-artifacts`.                                        |
| Task graph/TODO/run    | `packages/spark-tasks/src/index.ts`, `packages/spark/src/extension/spark-todo-tool-registration.ts`, `packages/spark/src/extension/spark-run-ready-tasks-tool-registration.ts` | currently `spark-tasks` + Spark facade | TODO already belongs to task state. Promote task/project/TODO/run as one generic task capability; do not create a separate TODO package. |
| Learnings              | `packages/spark-learnings/src/index.ts`, `packages/spark/src/extension/learning-tool-registration.ts`                                                                          | currently `spark-learnings`            | Evidence-backed learning is generic. Promote to `pi-learnings`, keep plural `.learnings/`.                                               |
| Active context         | `packages/spark/src/extension/spark-active-injection.ts`, `packages/spark/src/extension/spark-active-context.ts`                                                               | Spark facade                           | Context assembly is currently ad hoc Spark prompt building. Add `pi-context` provider/budget layer; Spark registers a provider.          |
| Recall/memory          | prior research note `.spark/notes/context-extensions-research-2026-06-04.md`                                                                                                   | none in repo                           | Add `pi-recall` for lightweight memory, explicitly distinct from `pi-learnings`.                                                         |
| Workflow saved scripts | `packages/spark-workflows/src`, `packages/spark/src/extension/spark-workflow-registry.ts`                                                                                      | currently `spark-workflows`            | Saved scripts are reusable Pi capability. Promote to `pi-workflows`; Spark `/workflow` delegates to it.                                  |
| Spark state cleanup    | `packages/spark/src/extension/spark-state-tool-registration.ts`, `docs/spark-store-inventory.md`                                                                               | Spark facade + individual stores       | Split broad cleanup into owner-specific maintenance actions. Avoid one broad unrestricted state cleanup tool.                            |
| Pi-only side thread    | `packages/pi-btw/`                                                                                                                                                             | `pi-btw`                               | Keep Pi-host-only. Do not add to native Spark CLI defaults or auto-ingest hidden side threads into main context.                         |
| Cue/Graft              | `packages/pi-cue`, `packages/pi-graft`                                                                                                                                         | `pi-cue`, `pi-graft`                   | Domain-specific explicit tool families are not duplicated by Spark. Keep out of this pass except common envelope/rendering improvements. |

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

Own project/task/TODO/run graph state. Package name may be plural for grouping, but the canonical tool is singular `task`.

Exports should come from current `spark-tasks` after rename/promotion:

- project/task/run/TODO types;
- `TaskGraphStore`;
- `TaskTodoStore`;
- readiness/state-machine helpers.

Canonical tool:

```ts
task({ action: "status" | "project_list" | "project_use" | "project_update" | "claim" | "plan" | "finish" | "todo_update" | "run_ready" | "run_status" | "run_control" | "cache_cleanup", ... })
```

Actions:

| Action           | Required inputs                                             | Controlled behavior                                                | Replaces / borrows from                                                                                   |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| `status`         | optional `view`, `limit`, `format`                          | active view by default, bounded output                             | `spark_status`                                                                                            |
| `project_list`   | optional status filter                                      | read-only                                                          | `spark_list_projects`                                                                                     |
| `project_use`    | existing selector or creation input                         | session-scoped selection; project creation through graph API       | `spark_use_project`                                                                                       |
| `project_update` | project selector + explicit changed fields                  | no arbitrary patch                                                 | `spark_rename_project`                                                                                    |
| `claim`          | stable task identity + plan metadata when creating/updating | one unfinished claim per session                                   | `spark_claim_task`                                                                                        |
| `plan`           | concrete tasks with plan/readiness fields                   | blocks open questions and missing evidence/steps                   | `spark_plan_tasks`                                                                                        |
| `finish`         | claimed task + terminal status + summary                    | completion evidence check remains enforced                         | `spark_finish_task`                                                                                       |
| `todo_update`    | `scope: "session"                                           | "task"`, ops array, optional task selector                         | uses existing TODO state machine; task scope requires current claimed task unless explicit owned selector | `spark_update_todos`, `spark_update_task_todos`, `rpiv-todo` state/blockedBy model |
| `run_ready`      | dryRun default true, concurrency/timeout                    | schedules ready task frontier only                                 | `spark_run_ready_tasks`, `pi-subagents` async UX                                                          |
| `run_status`     | run/task/project selectors                                  | read/reconcile status                                              | `spark_background_runs`, `spark_dag_manager status`                                                       |
| `run_control`    | `control: "kill"                                            | "reconcile"                                                        | "ack"`, explicit selector                                                                                 | broad kill requires `all: true`; no implicit all                                   | `spark_background_runs`, `spark_dag_manager` |
| `cache_cleanup`  | `dryRun` default true, staleness options                    | only task-owned/session TODO caches; protected graph never deleted | safe subset of `spark_state cleanup`                                                                      |

TODO is not a separate package or tool. It is a sub-action of the canonical task capability.

### `pi-ask`

Own all user-question UI and persisted ask answers.

Canonical tool:

```ts
ask({ mode: "clarification" | "decision" | "approval" | "unblock", action?: "ask" | "replay" | "list", questions?, provenance?, persistence? })
```

Actions/modes:

| Surface                                   | Behavior                                 | Replaces / borrows from         |
| ----------------------------------------- | ---------------------------------------- | ------------------------------- |
| `ask` with one question                   | uses single-question UI when appropriate | current `ask_user`              |
| `ask` with multiple questions or previews | uses flow/fullscreen UI                  | current `ask_flow`, `spark_ask` |
| `replay`                                  | replays latest/specified persisted ask   | `spark_ask_replay`              |
| `list`                                    | read-only persisted ask listing, bounded | artifact-backed ask history     |

UI improvements to absorb:

- submit review tab and option notes from `@juicesharp/rpiv-ask-user-question`;
- searchable split-pane and inline/overlay option from `pi-ask-user`;
- existing `pi-ask` flow preview height fix.

Spark-specific ask persistence becomes an adapter/provenance option in `pi-ask`, not a separate `spark_ask` concept.

### `pi-roles`

Keep ownership of reusable `RoleSpec` and concrete `RoleRun`. Consolidate tool surface.

Canonical tool:

```ts
role({ action: "list" | "get" | "create" | "run", ... })
```

Actions:

| Action   | Required inputs                                                | Controlled behavior                                                                        | Replaces      |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| `list`   | optional source/includeUser/limit                              | read-only                                                                                  | `list_roles`  |
| `get`    | role selector                                                  | include prompt only when explicit                                                          | `get_role`    |
| `create` | id, description, systemPrompt, rationale, expectedUses, source | no anonymous role; writable source project/user only                                       | `create_role` |
| `call`   | role, instruction, `mode: fresh \| forked`                     | explicit fork source when forked; Spark mode still prefers `task({ action: "run_ready" })` | `call_role`   |

### `pi-learnings`

Own evidence-backed reusable learning records and `.learnings/` storage.

Canonical tool:

```ts
learning({ action: "record" | "search" | "list" | "read" | "mark_stale" | "supersede" | "reject" | "export_markdown" | "import_markdown", ... })
```

Actions are direct promotions of current `spark_learning_*` tools. Guardrails:

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
workflow({ action: "list" | "read" | "validate" | "run" | "runs_status" | "runs_prune", ... })
```

Actions:

| Action        | Controlled behavior                                                | Replaces / borrows from                                         |
| ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `list`        | discovers only user/workspace saved script roots                   | `spark-workflow-registry`, `pi-prompt-template-model` discovery |
| `read`        | reads saved script metadata/body by selector                       | `pi-subagents chain get`                                        |
| `validate`    | parses frontmatter/script; no execution                            | `pi-prompt-template-model` validation                           |
| `run`         | executes saved script by selector only, no inline arbitrary script | `spark-workflows`, `pi-prompt-template-model run-prompt`        |
| `runs_status` | workflow-run invocation status                                     | `spark_dag_manager status`                                      |
| `runs_prune`  | dryRun default true                                                | `spark_state prune`, workflow-run retention                     |

`/workflow` in Spark remains saved scripts only. `/goal` remains a separate Spark command and is not a workflow selector.

## Spark facade after cutover

`packages/spark` should register Spark commands and Spark-specific providers/policy only:

- `/spark`
- `/research`
- `/plan`
- `/execute`
- `/goal`
- `/workflow`
- Spark context provider registration
- Spark predefined roles
- Spark widget/mode rendering, backed by `task` data

It should not register duplicate canonical tools for task, artifact, ask, role, learning, context, recall, or workflow.

## Migration table

| Current tool/command                      | Canonical replacement                                                                     | Keep?                                                 | Notes                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | --- | ------------------------------------------------------------------ |
| `spark_status`                            | `task({ action: "status" })` plus `context({ action: "status" })` for context diagnostics | No long-term alias                                    | Status rendering can stay shared internally.                              |
| `spark_list_projects`                     | `task({ action: "project_list" })`                                                        | No                                                    | Generic task capability owns project lists.                               |
| `spark_use_project`                       | `task({ action: "project_use" })`                                                         | No                                                    | Session-scoped selection remains.                                         |
| `spark_rename_project`                    | `task({ action: "project_update" })`                                                      | No                                                    | Rename/status/output language under explicit fields.                      |
| `spark_claim_task`                        | `task({ action: "claim" })`                                                               | No                                                    | Preserve one-claim-per-session rule.                                      |
| `spark_plan_tasks`                        | `task({ action: "plan" })`                                                                | No                                                    | Preserve readiness blocking rules.                                        |
| `spark_finish_task`                       | `task({ action: "finish" })`                                                              | No                                                    | Preserve completion evidence requirement.                                 |
| `spark_update_todos`                      | `task({ action: "todo_update", scope: "session" })`                                       | No                                                    | TODO belongs to task capability.                                          |
| `spark_update_task_todos`                 | `task({ action: "todo_update", scope: "task" })`                                          | No                                                    | Task-bound TODO requires claimed task/selector.                           |
| `spark_run_ready_tasks`                   | `task({ action: "run_ready" })`                                                           | No                                                    | Spark role scheduling remains an adapter behind task capability.          |
| `spark_background_runs`                   | `task({ action: "run_status" })`, `task({ action: "run_control" })`                       | No                                                    | Split read/control through action.                                        |
| `spark_dag_manager`                       | `task({ action: "run_status"                                                              | "run_control" })`and`workflow({ action: "runs_status" | "runs_prune" })`                                                          | No  | Low-level compatibility/debug surface should not remain canonical. |
| `spark_state status/doctor`               | `context({ action: "status" })` + owner-specific status actions                           | No                                                    | Avoid one broad state dumping ground.                                     |
| `spark_state cleanup`                     | `task({ action: "cache_cleanup" })`, `context({ action: "cache_cleanup" })`               | No                                                    | Owner-scoped dry-run cleanup only.                                        |
| `spark_state prune`                       | `workflow({ action: "runs_prune" })`                                                      | No                                                    | Workflow-run store owner handles retention.                               |
| `spark_state compact-role-run-artifacts`  | `artifact({ action: "compact" })`                                                         | No                                                    | Artifact owner handles blob retention.                                    |
| `spark_list_artifacts`                    | `artifact({ action: "list" })`                                                            | No                                                    | Generic artifact capability.                                              |
| `spark_get_artifact`                      | `artifact({ action: "read" })`                                                            | No                                                    | Generic artifact capability.                                              |
| `spark_ask`                               | `ask({ action: "ask", persistence: { artifact: true }, ... })`                            | No                                                    | Pi ask owns UI and persistence adapter.                                   |
| `spark_ask_replay`                        | `ask({ action: "replay" })`                                                               | No                                                    | Generic persisted ask replay.                                             |
| `ask_user`                                | `ask({ action: "ask", questions: [one] })`                                                | No as canonical                                       | May exist temporarily during migration only if not registered by default. |
| `ask_flow`                                | `ask({ action: "ask", questions: [...] })`                                                | No as canonical                                       | Flow UI remains implementation detail.                                    |
| `list_roles`                              | `role({ action: "list" })`                                                                | No                                                    | Consolidate pi-roles surface.                                             |
| `get_role`                                | `role({ action: "get" })`                                                                 | No                                                    | Consolidate pi-roles surface.                                             |
| `create_role`                             | `role({ action: "create" })`                                                              | No                                                    | Consolidate pi-roles surface.                                             |
| `call_role`                               | `role({ action: "call" })`                                                                | No                                                    | Direct one-off role run; Spark mode still prefers task runs.              |
| `spark_learning_record`                   | `learning({ action: "record" })`                                                          | No                                                    | Generic evidence-backed learning.                                         |
| `spark_learning_search`                   | `learning({ action: "search" })`                                                          | No                                                    | Generic evidence-backed learning.                                         |
| `spark_learning_list`                     | `learning({ action: "list" })`                                                            | No                                                    | Generic evidence-backed learning.                                         |
| `spark_learning_read`                     | `learning({ action: "read" })`                                                            | No                                                    | Generic evidence-backed learning.                                         |
| `spark_learning_mark_stale`               | `learning({ action: "mark_stale" })`                                                      | No                                                    | Generic evidence-backed learning.                                         |
| `spark_learning_supersede`                | `learning({ action: "supersede" })`                                                       | No                                                    | Generic evidence-backed learning.                                         |
| `spark_learning_reject`                   | `learning({ action: "reject" })`                                                          | No                                                    | Generic evidence-backed learning.                                         |
| `spark_learning_export_markdown`          | `learning({ action: "export_markdown" })`                                                 | No                                                    | Generic export.                                                           |
| `spark_learning_import_markdown`          | `learning({ action: "import_markdown" })`                                                 | No                                                    | Generic import.                                                           |
| `/spark`                                  | `/spark`                                                                                  | Yes                                                   | Spark mode command.                                                       |
| `/research`, `/plan`, `/execute`, `/goal` | same                                                                                      | Yes                                                   | Spark mode commands.                                                      |
| `/workflow`                               | `/workflow` delegating to `workflow({ action: "run" })`                                   | Yes                                                   | Saved scripts only.                                                       |
| `/workflow:goal`                          | none                                                                                      | No                                                    | Goal is not workflow.                                                     |
| `cue_*`, `graft_*`                        | unchanged for this pass                                                                   | Yes                                                   | Not duplicated Spark concepts; explicit schemas remain safer for now.     |

## Implementation order

1. **Contract and tests first.** Keep this document as the migration contract; update tests to describe canonical surfaces before or with implementation.
2. **Promote artifacts.** Extract artifact store/tool to `pi-artifacts`; update artifact consumers.
3. **Promote tasks.** Rename/promote `spark-tasks` to `pi-tasks`; merge project/task/TODO/run tools into `task` actions.
4. **Consolidate ask and role.** Make `ask` and `role` canonical action tools; move Spark ask persistence into `pi-ask`.
5. **Promote learnings.** Rename/promote `spark-learnings` to `pi-learnings`; keep `.learnings/` semantics.
6. **Add context and recall.** Implement provider-based context bundles and controlled recall candidates.
7. **Promote workflows.** Make saved scripts a `pi-workflows` capability; keep `/goal` separate.
8. **Cut over Spark facade.** Spark registers commands/providers/policy only and removes duplicate concept tools from active registration.
9. **Review and cleanup.** Grep for duplicate canonical tool guidance, run tests/checks, and reject uncontrolled schema holes as blockers.

## Validation checklist

- `pnpm run check:tsc` passes.
- Focused tests for artifacts, tasks/TODOs, ask flow, roles, learnings, workflows, and Spark commands pass.
- Grep finds no canonical `spark_*` registrations for concepts owned by `pi-*` capabilities.
- Docs and skills direct agents to `task`, `artifact`, `ask`, `role`, `learning`, `context`, `recall`, and `workflow` tools.
- Mutating tools have strict schemas and provenance/scope.
- Broad cleanup/destructive actions default to dry-run and target only owner-approved stores.
- Automatic learning/recall writes enter candidate/review when evidence or user approval is absent.
- Context reinjection cannot pass arbitrary prompt text; it only composes registered providers under budget.
- Hidden side threads and web results are never automatically promoted to task evidence or learning.
