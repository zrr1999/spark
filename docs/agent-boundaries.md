# Agent package boundaries

Spark currently mixes two concerns under Spark-named packages:

1. **Agent specs** — durable definitions of agent personas/capabilities.
2. **Agent runs** — concrete Pi subprocess executions of an agent spec.

The target boundary is that reusable, Spark-independent pieces move to `pi-*` packages, while Spark keeps only task/DAG/workflow adaptation.

## Current evidence

- `packages/spark-core/src/index.ts` defines generic-looking agent contracts (`AgentSpec`, `AgentRunRecord`, `AgentInstruction`) next to Spark refs and task/artifact contracts. Because they use `AgentRef`, `RunRef`, and `ArtifactRef` from `spark-core`, any consumer of these generic contracts currently depends on Spark.
- `packages/spark-agents/src/index.ts` owns `AgentRegistry`, builtin specs, and `ProjectAgentSpecStore`. These are spec-definition responsibilities and do not depend on tasks or artifacts; the remaining Spark package name and small legacy aliases are temporary until the generic `pi-agent-spec` extraction lands.
- `packages/spark-runtime/src/index.ts` owns both generic run mechanics (`buildPiAgentArgs`, `runAgentInstructionOnly`, `runPiJsonAgent`, process tracking/kill/timeout) and Spark adaptation (`runSparkTask`, `runReadySparkTasks`, task claims, TODO/artifact updates). The generic Pi subprocess runner is reusable outside Spark; the DAG/claim parts are not.
- `packages/spark/src/extension/index.ts` exposes Spark workflow tools (`spark_claim_task`, `spark_plan_tasks`, `spark_run_ready_tasks`) alongside spec tools (`spark_list_agent_specs`, `spark_get_agent_spec`, `spark_create_agent_spec`). The latter should become Spark wrappers over generic agent-spec primitives.

## Target ownership

## Spec/run separation invariant

- An **agent spec** is a definition: persona, instructions, allowed tools, default model, and provenance source.
- An **agent run** is a concrete execution: run ID, launch mode, parent/child session metadata, process state, output, timeout, and continuation state.
- Every run references an existing spec; specs do not embed run mode.
- `fresh` and `forked` are the only runtime launch modes in the target model.
- `managed` is neither a spec source nor a launch mode; if legacy data says `managed`, migrate it to an explicit source such as `project` or `workspace`.

See [agent-run-modes.md](./agent-run-modes.md) for the operational difference between reusable specs, fresh/spec-based runs, and forked-context runs, including safety and attribution rules.

### `pi-agent-spec` (new generic package)

Owns agent definition data and persistence, with no `spark-core` dependency. See [pi-agent-spec-api.md](./pi-agent-spec-api.md) for the proposed API.

- `AgentSpecRef` / string refs or plain IDs independent of Spark refs.
- `AgentSpec` with `id`, `source`, `description`, `systemPrompt`, optional `allowedTools`, optional `defaultModel`, timestamps.
- `AgentSpecSource = "builtin" | "project" | "user" | "workspace"`.
- Registry operations: add/get/list/select.
- JSON store operations for non-builtin specs.
- Proposal-to-spec validation helpers.

Terminology note: **avoid `managed` as a public spec source**. It describes implementation/storage, not provenance. Prefer `project`, `user`, or `workspace` depending on where a spec is stored.

### `pi-agent-run` (new generic package)

Owns concrete Pi agent execution, with no `spark-core` dependency:

- `AgentRunRef` / run IDs independent of Spark refs.
- `AgentRunMode = "fresh" | "forked"`.
- `AgentRunRequest` referencing an existing `AgentSpec` or spec ref.
- Pi CLI arg construction and JSONL event parsing.
- Process tracking, timeout detachment, kill/resume metadata.
- Run records and output truncation policies.

Every run must reference an existing spec. `fresh`/`forked` are runtime launch modes; they are not spec sources. Fresh/spec-based runs are the default for isolated Spark task execution; forked-context runs require an explicit parent session/context source.

### Spark packages remain Spark-specific

- `spark-tasks` owns threads, tasks, DAG dependencies, task TODOs, claim leases, and readiness.
- `spark-runtime` should become the adapter that maps a Spark task to a `pi-agent-run` request and maps run completion back to task status, task claims, artifacts, and DAG scheduling.
- `spark` extension tools should keep Spark workflow semantics and may provide compatibility wrappers while generic tools settle.

## Migration sketch

1. Extract spec-only types and registry/store behavior from `spark-core`/`spark-agents` to `pi-agent-spec`.
2. Rename persisted non-builtin source terminology from `managed` to a provenance source (`project` for `.spark/agents` or `workspace` for workspace-local specs). Keep any compatibility shim small and temporary.
3. Extract `runAgentInstructionOnly`, Pi arg construction, JSONL parsing, process tracking, timeout detachment, and kill APIs from `spark-runtime` to `pi-agent-run`.
4. Keep `runSparkTask` and `runReadySparkTasks` in `spark-runtime`, but have them call `pi-agent-run` and translate generic run records into Spark `TaskRun`/artifact state.
5. Keep Spark-facing tools on spec language (`spark_list_agent_specs`, `spark_get_agent_spec`, `spark_create_agent_spec`) and keep old names only as thin transitional aliases if needed.

## Non-goals

- Cross-thread or cross-plugin DAG dependencies.
- Treating `managed` as a runtime mode.
- Running agents that do not reference a persisted/builtin spec.
- Moving Spark task claims, DAG state, TODOs, asks, artifacts, or review gates into generic Pi packages.
