# Live dynamic workflow parity evidence

This is the final evidence matrix for the Spark live dynamic workflow refactor. It maps the Claude Code-style dynamic workflow expectations to concrete code paths, focused tests, and task evidence artifacts.

## Parity matrix

| Capability | Evidence | Notes |
| --- | --- | --- |
| Background `workflow_run` returns before terminal completion | `test/spark-workflows.test.ts` — `Spark workflow_run returns before background DynamicWorkflowManager completes`; artifact `artifact:08d4549d-df87-4447-8d12-bdb564773f08` | Default execution is manager-owned/background. `wait: true` remains explicit compatibility. |
| Foreground live streaming | `test/spark-workflows.test.ts` — `Spark workflow_run streams live onUpdate events before wait=true completion`; artifact `artifact:8f422d38-f1d0-40e3-b095-4825f62a6d74` | Foreground callers receive compact stage/agent/tool updates before terminal result. |
| Real controls | `test/spark-workflows.test.ts` — `Spark DynamicWorkflowManager applies pause, resume, stop, and restart to active runs`; artifact `artifact:5a69b36a-6c3d-4b8d-a658-db8fff5d17b1` | Controls route through `SparkDynamicWorkflowManager`, emit `control_applied`, and stop/restart active generations safely. |
| Event-sourced v2 store and migration | `test/spark-workflows.test.ts` — `Spark dynamic workflow event store migrates v1 dynamic records`; artifact `artifact:518176b0-17c3-4357-83e0-2540551c8052` | Active runs persist under `.spark/dynamic-workflows/runs/<run-id>/`; `.spark/dynamic-workflow-runs.json` is legacy-import-only. |
| Dashboard run list/tree/event tail/controls | `test/spark-tools.test.ts` — `/workflow selector commands...`, `impl_workflow_runs renders and controls dynamic workflow_run records`; artifact `artifact:18d27128-8901-413d-827c-61efada1e8dc` | `/workflows`, `impl_workflow_runs`, and status surfaces share the same snapshot-backed dashboard projection. |
| Manual dashboard demo | artifact `artifact:61d7b4aa-603c-49a7-81a1-a63ceae9dfd8` | Transcript shows running and completed runs, selected tree, event tail, saved workflow, ack state, and restart via manager. |
| Background result inbox and ack | `test/spark-tools.test.ts` — `impl_status includes active dynamic workflow snapshot projection`; `test/spark-widget.test.ts` — dynamic workflow result tests; artifact `artifact:dde2b384-1564-41c6-9b2f-924a63e16bfc` | Terminal unacknowledged results/errors appear in status/widget until `ack`. |
| Fan-out/helper/nested tree telemetry | `test/spark-workflows.test.ts` — `spark-workflows projects zero-agent parallel helper work into dashboard tree`, `spark-workflows exposes quality helpers...`; artifact `artifact:20bf0850-4fde-4b2a-8441-a3854cbb5ff4` | Zero-agent workflows still show `parallel_group`, `parallel_item`, `tool`, `artifact`, and `nested_workflow` nodes. |
| Graft isolated edit provenance | `test/spark-workflows.test.ts` — `Spark dynamic workflow dashboard renders isolated Graft agent provenance`; opt-in `test/spark-workflows-graft-e2e.test.ts`; artifact `artifact:9ef8dea1-1972-442a-9e5c-95db8eab1478` | Agent nodes render scratch/candidate/patch refs and inferred validation status (`scratch`, `candidate`, `admitted`). |
| Hard cutover away from v1 active surfaces | `test/spark-workflows.test.ts` — `Spark production dynamic workflow surfaces are cut over to v2 event store`; artifact `artifact:cd0d2a58-9d63-4701-9e39-cff57e79dec1` | Production dynamic workflow surfaces no longer call the v1 default store. |

## Focused final command set

```text
pnpm --filter @zendev-lab/pi-extension run check
node --experimental-strip-types --test --test-name-pattern "workflow_run returns before background|streams live onUpdate|DynamicWorkflowManager applies pause|zero-agent parallel helper|dashboard renders isolated Graft|production dynamic workflow surfaces are cut over|event store migrates v1" test/spark-workflows.test.ts
node --experimental-strip-types --test --test-name-pattern "impl_status includes active dynamic workflow snapshot projection|impl_workflow_runs renders|/workflow selector commands" test/spark-tools.test.ts
node --experimental-strip-types --test --test-name-pattern "dynamic workflow result|active dynamic workflow snapshot progress|projects active dynamic workflow snapshots" test/spark-widget.test.ts
node --experimental-strip-types --test --test-name-pattern "graft isolation E2E" test/spark-workflows-graft-e2e.test.ts
pnpm exec oxlint --deny-warnings <changed live workflow files and tests>
pnpm exec vp fmt --check <changed live workflow files and tests>
git diff --check -- <changed live workflow files and tests>
```

The Graft E2E remains opt-in when the daemon/binaries are unavailable: set `PI_GRAFT_E2E=1` to run the real workflow/Graft isolation smoke test.

## Final closure assessment

The refactor now satisfies the original objective: Spark dynamic workflows are live/background by default, event-sourced, controllable through a real manager, visible in a dashboard/widget/status projection, able to deliver background results through an acknowledgement inbox, able to show fan-out/helper/nested work even with zero agents, and able to surface Graft isolated-edit provenance without attaching workflow output to task/project state unless explicitly requested.
