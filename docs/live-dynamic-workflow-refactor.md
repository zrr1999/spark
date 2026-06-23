# Spark live dynamic workflow refactor

This document is the acceptance contract for turning Spark dynamic workflows from a synchronous `workflow_run` helper into a genuinely live, Claude Code-level workflow system. It is intentionally stricter than the current backend feature checklist: a workflow is not considered dynamic unless the main session can start it, observe it while it runs, control it while it runs, and receive the result after the original prompt has returned.

## Problem statement

The current implementation has useful runtime primitives, persistence, Graft isolation, saved workflows, and a better completion card, but the user-visible system is still not dynamic enough:

- `workflow_run` executes the script synchronously in one tool call and awaits `runWorkflow(...)` before returning (`packages/spark-extension/src/extension/spark-workflow-run-tool-registration.ts`).
- The tool execution callback receives `_onUpdate`, but live phase/agent updates are not streamed to the host UI.
- Persisted dynamic workflow state is a snapshot JSON store, not a live event stream.
- Pause/resume/stop/restart controls mostly mutate stored status; they do not yet control the active runtime scheduler or child role runs.
- Spark has two run concepts: legacy/background workflow runs and dynamic workflow runs. The widget still reads the legacy store, while `/workflows` mixes old and new concepts.
- `parallel()`, web/fetch helpers, `verify`, `judgePanel`, nested workflows, gates, retries, and artifact calls are not first-class visible UI nodes. A workflow can do real parallel work while the UI still says `agents=0`.
- Graft isolated agent provenance is not visible enough for code-editing workflows.

## Gap severity

### P0 gaps: parity blockers

- **Not live**: `workflow_run` blocks the tool call until terminal completion instead of returning a managed background run.
- **Fake controls**: pause/resume/stop/restart mutate stored status without controlling the active runtime scheduler and child operations.
- **Split run state**: legacy background workflow status and dynamic workflow records are separate models, so widget/status/dashboard cannot show one coherent live workflow truth.
- **No event stream**: snapshot-only persistence cannot drive a live dashboard or reliable replay/tail UI.

### P1 gaps: major UX/observability gaps

- **Fan-out is invisible**: `parallel()` and helper calls do not produce first-class UI nodes, so real dynamic work can render as `agents=0`.
- **Phase model is too flat**: phases lack child nodes, progress, current status, and automatic lifecycle semantics.
- **No background result delivery**: terminal results are not delivered through an inbox/task-panel model after the original prompt returns.
- **Graft provenance is hidden**: isolated editing agents do not surface scratch/candidate/patch/validation refs in the workflow tree.

### P2 gaps: polish and cutover gaps

- **Approval review is not dashboard-native**: script preview, risks, resources, and approval history are not yet one cohesive workflow view.
- **Migration/cutover is incomplete**: docs and tests can still imply parity from backend primitives or final text output.
- **Retention/compaction needs v2 semantics**: dynamic workflow history needs event-log compaction and migration rules.

## Target user experience

### Start

A user asks for a workflow, deep research, ultracode, or another multi-agent/fan-out task. Spark should:

1. Parse/resolve the metadata-first workflow script.
2. Show script/risk/resource review when approval is required.
3. Start a managed dynamic workflow run.
4. Return quickly with a live run card by default, not wait for terminal completion unless the caller explicitly requests foreground wait.

### Live inspect

While the run is active, the user can inspect `/workflows` or `task_read({ action: "run_status", runAction: "inspect", runRef })` and see:

- run status, source, script hash, started/updated time, approval and base metadata;
- phase tree with current/completed/failed/skipped phases;
- fan-out tree: parallel groups, items, agents, tool/helper calls, nested workflow calls, gates, retries, and artifacts;
- per-node status, timing, result/error snippets, token usage, liveness, child run refs, and Graft refs when available;
- event log tail for debugging;
- available controls for the current state.

### Control

Controls must affect the active execution, not only the stored status:

- `pause`: stop scheduling new phase/agent/parallel/helper work at cooperative checkpoints; active child calls may finish unless explicitly stopped.
- `resume`: continue from the persisted journal/checkpoint without repeating completed unchanged agent work.
- `stop`: abort the manager and active child role runs/web/fetch calls; terminal state is `stopped`.
- `restart`: reset the active snapshot/journal according to policy and start a new manager-owned execution without requiring a second manual `workflow_run({ runRef })` call unless explicitly dry-run.
- `save`: save the script through controlled `workspace:*` or `user:*` selectors.
- `ack`: acknowledge delivered terminal results and hide them from compact status.

### Deliver

A background run finishing after the original prompt returns should create a workflow delivery record/inbox item. The main session/status/widget should surface the undelivered result/error until acknowledged.

### Code-edit provenance

For `agent(..., { isolation: "graft" })`, each isolated agent node should surface scratch/candidate/patch refs and validation status, so reviewers can trace edits without inspecting raw transcripts.

## Architecture boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| `pi-workflows` | Generic workflow script runtime, deterministic execution helpers, typed runtime events, snapshot projection helpers that are host-neutral | Spark project/task state, approval policy, role registry, Graft-specific policy, UI rendering |
| `spark-runtime` | Role-run execution adapter, per-run environment/tool policy, child process control hooks, model/usage extraction | Workflow store schema, dashboard rendering, project/task mutations |
| `spark-extension` | `workflow_run` tool, approvals, dynamic workflow manager, event store, controls, widget/status/dashboard renderers, workflow delivery inbox, saved workflow selectors | Generic runtime semantics that belong in `pi-workflows` |
| `pi-graft`/Graft | Scratch/candidate/patch/capture primitives and validation provenance | Workflow orchestration policy or dashboard layout |

This separation keeps mechanism and presentation decoupled: `pi-workflows` emits typed facts; Spark decides how to persist, approve, control, and render them.

## Data model

### WorkflowRunEvent

The runtime/manager should write append-only events. Event payloads must be JSON-serializable, stable, and replayable.

Minimum event families:

| Event family | Examples | Purpose |
| --- | --- | --- |
| run lifecycle | `run_started`, `run_resumed`, `run_succeeded`, `run_failed`, `run_stopped`, `run_stale` | terminal status and recovery |
| control | `control_requested`, `control_applied`, `control_rejected` | prove controls affect runtime |
| phase | `phase_started`, `phase_succeeded`, `phase_failed`, `phase_skipped` | phase timeline/tree |
| execution node | `node_started`, `node_succeeded`, `node_failed`, `node_skipped` with `nodeKind` | generic tree for parallel/helper/nested/agent/tool work |
| parallel | `parallel_group_started`, `parallel_item_started`, `parallel_item_finished` | show fan-out even without agents |
| agent | `agent_started`, `agent_telemetry`, `agent_succeeded`, `agent_failed` | child run refs, usage, liveness |
| helper/tool | `web_search_started`, `fetch_content_started`, `artifact_recorded`, `verify_started`, `judge_panel_started`, `gate_waiting` | expose non-agent dynamic work |
| Graft | `graft_scratch_created`, `graft_candidate_created`, `graft_patch_admitted`, `graft_validation_recorded` | edit provenance |
| output | `result_available`, `delivery_created`, `delivery_acknowledged` | background result delivery |
| diagnostics | `log`, `warning`, `error` | debuggability |

Every event should include at least:

```ts
interface WorkflowRunEventBase {
  id: string;
  runRef: string;
  sequence: number;
  timestamp: string;
  type: string;
  parentId?: string;
  phaseId?: string;
  nodeId?: string;
}
```

### WorkflowRunSnapshot

The UI should render a derived projection, not ad hoc store records. Minimum shape:

```ts
interface WorkflowRunSnapshot {
  runRef: string;
  status: "queued" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "succeeded" | "failed" | "stale";
  meta: { name: string; description: string };
  source: { kind: "inline" | "selector"; label: string; selector?: string };
  scriptHash: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  controls: Array<"pause" | "resume" | "stop" | "restart" | "save" | "ack">;
  phases: WorkflowRunNode[];
  nodesById: Record<string, WorkflowRunNode>;
  eventTail: WorkflowRunEvent[];
  usage?: WorkflowUsageTotals;
  result?: unknown;
  errorMessage?: string;
  delivery?: { status: "undelivered" | "delivered" | "acknowledged"; ref?: string };
}
```

`WorkflowRunNode` should represent phases, parallel groups, parallel items, agents, helper/tool calls, nested workflows, artifacts, and Graft provenance nodes with a common status/timing/result/error/children interface.

## Storage layout

Move from one `.spark/dynamic-workflow-runs.json` snapshot file toward a versioned event store:

```text
.spark/dynamic-workflows/
  runs/
    <run-id>/
      run.json              # immutable run metadata + current compact status
      events.jsonl          # append-only typed events
      snapshot.json         # compact projection, rewriteable
      script.js             # exact script body for resume/save/review
      deliveries.json       # optional result delivery/ack state
  index.json                # recent/active run index
  migrations/
```

The existing `.spark/dynamic-workflow-runs.json` should become legacy-import-only after migration tests prove old records are preserved.

## Manager lifecycle

A new `DynamicWorkflowManager` in `spark-extension` should own lifecycle:

1. `start({ script | selector, args, options })`
   - resolves script;
   - captures base metadata;
   - performs approval;
   - appends `run_started`;
   - starts background execution;
   - returns `runRef` and current snapshot.
2. `resume(runRef)`
   - appends control events;
   - starts execution from stored script/journal/checkpoint.
3. `pause(runRef)`
   - sets desired control state;
   - runtime checkpoints stop scheduling new work;
   - appends `control_applied` when paused.
4. `stop(runRef)`
   - aborts manager and child operations;
   - appends terminal stop event.
5. `restart(runRef)`
   - records restart reason;
   - resets/branches execution state;
   - starts manager-owned run.
6. `subscribe(runRef)` / `tail(runRef)`
   - lets tools/widget/dashboard stream or poll events.

## Runtime requirements

`pi-workflows` should add host-neutral event hooks without knowing Spark:

- `onEvent(event)` as the canonical callback.
- Existing callbacks (`onPhase`, `onAgentTelemetry`, `onAgentJournal`, `onTokenUsage`) can be bridged during migration but should not remain the primary UI model.
- Cooperative control hooks:
  - `shouldPause()` / `waitWhilePaused()` or equivalent manager-provided checkpoint;
  - `signal` propagation for stop/cancel;
  - checkpoints before scheduling phase work, parallel items, agents, web/fetch, artifactRecord, nested workflow, retry attempts, and gates.
- Structured node IDs and parent IDs for phase/parallel/agent/helper hierarchy.

## UI surfaces

### Tool result

`workflow_run` default result should be a start card, not a terminal card:

```text
╭─ Workflow <name> [running]
│ run      run:...
│ source   inline workflow
│ script   <hash>
│ phases   Plan → Search → Synthesize
│ controls inspect · pause · stop
╰─ Live: /workflows or task_read({ action: "run_status", runAction: "inspect", runRef: "..." })
```

If `wait` or foreground mode is explicitly requested, it may stream `onUpdate` cards and return terminal output when complete.

### `/workflows` dashboard

The dashboard should be view-model-first and testable without a terminal:

- left/list: active, paused, failed, delivered, recent runs;
- center/tree: phases and execution nodes;
- right/detail: selected node prompt/result/error/usage/logs/provenance;
- footer/actions: pause/resume/stop/restart/save/ack/open result;
- event tail/log panel.

### Widget/status

The Spark widget should read dynamic workflow snapshots, not only legacy background workflow run status. Compact status should show active dynamic runs and undelivered terminal results.

## Acceptance matrix

| Priority | Capability | Acceptance criteria | Owning task |
| --- | --- | --- | --- |
| P0 | Background start | `workflow_run` returns before a delayed workflow completes; store later reaches terminal state | `@workflow-background-manager` |
| P0 | Real controls | pause/resume/stop/restart alter active execution and produce control events | `@workflow-real-controls` |
| P0 | Unified live state | widget/status/dashboard read one dynamic workflow snapshot projection | `@workflow-live-ui-bridge` |
| P0 | Event store | append/replay/compact event log with migration from current JSON store | `@workflow-event-store-v2` |
| P1 | Fan-out tree | `parallel()` and helper calls appear in UI even with `agentCount=0` | `@workflow-fanout-tree-telemetry` |
| P1 | Dashboard | `/workflows` exposes run list, phase/agent tree, details, logs, controls | `@workflow-dashboard-tui` |
| P1 | Result delivery | background completion creates deliverable result/error until ack | `@workflow-result-inbox-delivery` |
| P1 | Graft provenance | isolated agents show scratch/candidate/patch/validation refs | `@workflow-graft-provenance-ui` |
| P2 | Approval review UX | script/risk/resource review is integrated into workflow run view | covered across dashboard/control tasks |
| P2 | Hard cutover | docs/tests remove claims based only on backend primitives and retire duplicated stores | `@workflow-v2-migration-hard-cutover` |
| P2 | Parity E2E | deterministic E2E proves live updates, controls, fan-out tree, delivery, and Graft provenance | `@workflow-parity-e2e-v2` |

## Migration and cutover

1. Add event model and projection while preserving existing snapshot APIs.
2. Introduce v2 store and migrate current `.spark/dynamic-workflow-runs.json` into v2 snapshots/events.
3. Move `workflow_run` to the manager with an explicit bounded wait mode for tests and callers that need synchronous behavior.
4. Rewire `/workflows`, `task_read run_status`, status, and widget to the v2 projection.
5. Add real controls and dashboard.
6. Mark old dynamic snapshot file as legacy-import-only.
7. Remove stale docs/tests that describe parity as completed by backend primitives or final text output only.

## Risks

- **Long-running process lifecycle**: background execution must not leak child role runs or orphan controls.
- **State split during migration**: keep the cutover bridge short-lived and tested; do not let v1 and v2 stores remain dual active concepts.
- **UI overfitting**: render from stable snapshots, not from terminal-specific formatting.
- **Control races**: stop/pause/resume must be idempotent and terminal-state-safe.
- **Token/cost accuracy**: report actual when available and visible estimated/unavailable otherwise; never invent cost.
- **Graft safety**: UI must not imply direct working-tree writes are isolated; provenance should point to scratch/candidate/patch refs.

## Validation strategy

- Unit tests for event emission and snapshot projection in `pi-workflows`.
- Store tests for append/replay/compact/migration in `spark-extension`.
- Manager tests with delayed workflows proving background return and eventual terminal state.
- Control tests proving pause/resume/stop/restart affect active execution.
- Rendering/view-model tests for active, paused, failed, stopped, succeeded, and delivered runs.
- Fan-out tests where a zero-agent workflow still shows parallel/helper nodes.
- Graft opt-in E2E proving isolated edit provenance appears in the workflow tree.
- Final parity E2E and demo transcript before requesting goal completion.
