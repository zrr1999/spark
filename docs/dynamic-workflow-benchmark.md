# Dynamic workflow benchmark

This is the minimum bar for Spark workflow after reviewing Claude Code dynamic workflows and `@quintinshaw/pi-dynamic-workflows`.

## External baseline

### Claude Code dynamic workflows

Claude Code defines dynamic workflows as JavaScript orchestration scripts that Claude writes for a task, while a runtime executes the script in the background so the main session stays responsive. The documented use cases are codebase-wide sweeps, large migrations, cross-checked research, and multi-angle planning. The important product expectations are:

- A workflow is code-mode orchestration: the script, not the chat turn, owns loops, branching, fan-out, and intermediate state.
- `/deep-research` is the bundled proof-point: fan out searches, fetch/cross-check sources, and synthesize a cited report.
- Direct prompts such as “use a workflow”/`ultracode` can cause Claude to write and run a workflow.
- `/workflows` is the control plane: progress by phase/agent, pause/resume/stop/restart, inspect agent details, and save a run as a reusable command.
- Runs require explicit approval in interactive permission modes and have hard runtime limits: no direct filesystem/shell access in the script, up to 16 concurrent agents, and 1000 agents per run.
- Resume reuses completed agent results for the unchanged prefix.

Primary source: Claude Code docs, “Orchestrate subagents at scale with dynamic workflows”: https://code.claude.com/docs/en/workflows.md

### `@quintinshaw/pi-dynamic-workflows`

The Pi package positions itself as “Claude Code–style dynamic workflows for Pi” and exposes the concrete feature floor we need to meet or exceed:

- Script primitives: `agent()`, `parallel()`, `pipeline()`, `phase()` with 16-concurrent / 1000-agent caps and intermediate results kept out of chat context ([README lines 70-71](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/README.md#L70-L71)).
- Journaled resume and worktree isolation ([README lines 72-73](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/README.md#L72-L73)).
- Real token/cost accounting, background delivery, detailed progress, and `/workflows` TUI ([README lines 74-76](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/README.md#L74-L76)).
- Built-in quality stdlib (`verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`), `ultracode`, `/deep-research`, `/adversarial-review`, and saved/nested workflows ([README lines 77-80](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/README.md#L77-L80)).
- Runtime implementation hardens determinism, applies model/agent routing, journals completed calls, supports worktrees, nested workflows, checkpoints, quality helpers, retry/gate helpers, and budget APIs in `src/workflow.ts` ([workflow runtime highlights](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/src/workflow.ts#L246-L861)).
- Its workflow tool makes generated raw JavaScript executable, background by default, and teaches the model explicit script-writing guidelines including quality helpers and model tiers ([workflow tool highlights](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/src/workflow-tool.ts#L136-L347)).
- Its manager persists run state, recovers stale runs as paused, supports background/sync execution, pause/resume/stop, and journals agent completions ([manager highlights](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/src/workflow-manager.ts#L107-L527)).
- Its task panel delivers completed background runs back into the conversation and shows detailed token-rate progress ([task panel highlights](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/src/task-panel.ts#L96-L375)).
- Its deep research workflow explicitly plans diverse queries, uses web tools, cross-checks claims, and cites source URLs ([deep research implementation](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/8a33ed72b37c118c54067e2689642f4d6c56d45e/src/deep-research.ts#L20-L72)).

## Spark target: better, not worse

Spark workflow must keep the existing `pi-workflows`/`spark-runtime` boundary, but feature parity is not optional. The target bar:

1. **Script runtime**: metadata-first JavaScript scripts; `agent`, `parallel`, `pipeline`, `phase`, `workflow`, `artifactRecord`, `budget`, `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, and `gate`.
2. **Deterministic resumability**: journal by deterministic call index/hash, replay only the unchanged prefix, block accidental `Date.now()`, `Date()`, `new Date()`, and `Math.random()` inside workflow scripts.
3. **Execution surface**: a Spark-owned `workflow_run` tool can execute either a saved selector or a generated inline script through the Spark role-run adapter without turning workflow into project/task state.
4. **Resource bounds**: default 16-way concurrency, 1000-agent cap, optional run/phase token budgets, optional `maxAgents` and `concurrency` controls.
5. **Quality patterns**: first-class adversarial verification, best-of-N judging, dry-loop discovery, completeness checks, bounded retry, and feedback gates.
6. **Saved/nested workflows**: controlled resolver only; no arbitrary path execution.
7. **Next hardening still required before declaring total parity**: plan-task diagnostics cleanup and final parity E2E.

## Parity matrix

| Baseline capability | Spark status | Evidence |
| --- | --- | --- |
| Metadata-first dynamic JavaScript workflows | Implemented, tested, documented | `parseWorkflowScript`, `runWorkflowScript`, `workflow_run`, `test/spark-workflows.test.ts` |
| Subagent fan-out and bounded orchestration | Implemented, tested, documented | `agent`, `parallel`, `pipeline`, `maxAgents`, `concurrency`, ultracode smoke |
| Deterministic resume/replay | Implemented, tested, documented | journal hash replay and `workflow_run({ runRef })` tests |
| Background/control UI for dynamic runs | Implemented, tested, documented | `/workflows` and `task_read run_status` pause/resume/stop/restart/save/ack rendering |
| Saved/nested workflows | Implemented, tested, documented | controlled `builtin:*`/`workspace:*`/`user:*` resolver, collision-safe save/list/read/rerun test |
| Quality helpers | Implemented, tested, documented | `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate` tests |
| Deep research and adversarial review | Implemented, tested, documented | builtin `research`/`review`, webSearch/fetchContent adapters, collected-error tests |
| Approval/script-review UX | Implemented, tested, documented | scoped approval summary/provenance tests and docs |
| Token/cost/liveness telemetry | Implemented, tested, documented | role-run usage extraction and dynamic run rendering tests |
| Graft-backed isolated agent execution | Implemented, tested, documented | `isolation: "graft"`, narrowed tool policy, real opt-in Graft E2E |
| Ultracode/high-effort opt-in | Implemented, tested, documented | `/ultracode` command prompt test and generated-script workflow_run smoke |

## Implemented in this change

- `pi-workflows` runtime now has deterministic metadata-first scripts, 16-concurrency default, token budget APIs, phase budgets, longest-unchanged-prefix resume, nested workflow composition, item pipelines, webSearch/fetchContent adapters for research workflows, and the quality stdlib.
- Spark now registers `workflow_run`, a visible execution surface for generated/saved workflow scripts that routes agents through Spark workflow role-run boundaries and approval-gates risky runs before child agents or web/fetch adapters start. `/ultracode` is the explicit opt-in high-effort command that asks the agent to reuse a saved workflow or generate a bounded metadata-first script and run it through `workflow_run`.
- `workflow_run` persists dynamic run records in `.spark/dynamic-workflow-runs.json` with script hash/body, args, metadata, phases, journal, result/error, captured base metadata, scoped approval provenance when required, per-agent telemetry, child run refs, actual/estimated token totals, optional cost, and liveness/rate signals; `workflow_run({ runRef })` resumes from the stored script, journal, original approval, and original base.
- Graft scratch/capture supports process-scoped `GRAFT_BASE_REF` as the implicit first-operation base when explicit `--base`/tool `base` and `--from`/tool `from` are absent. Explicit base still wins, `from` continuation ignores env base, and missing/blank env base fails loudly. Spark workflow agents can request `isolation: "graft"`; Spark injects the persisted workflow base as `GRAFT_BASE_REF`, narrows the child role-run tools to Graft scratch/candidate/validation operations, and captures scratch/candidate/patch refs in isolated agent results.
- `task_read({ action: "run_status" })` / the `/workflows` control surface now renders persisted dynamic `workflow_run` records with phase summaries, agent journal tail metadata/result snippets, completed results, base metadata, actual/estimated token totals, optional cost, agent liveness/rate telemetry, errors, saved workflow selectors, acknowledged state, and next actions. Dynamic controls `pause`, `resume`, `stop`, `restart`, `save`, and `ack` update `.spark/dynamic-workflow-runs.json` deterministically; `restart` resets phases/journal and points callers back to `workflow_run({ runRef })` for execution, `save` writes the script to controlled workspace or user workflow files with collision-safe suffixing, and `ack` hides delivered terminal runs from compact status.
- Builtin `research` is now the deep-research product flow: query planning, multi-query web search, fetch/cross-checking, source analyst verification, collected error handling, and cited report synthesis. Builtin `review` is now the adversarial-review product flow: investigation/search, parallel critiques, rebuttal, and verdict synthesis.
- Focused tests cover runtime hardening, resume semantics, quality helpers, real/fallback token budget enforcement, role-run usage extraction, nested workflows, deep-research/review builtin behavior with mocked web/fetch adapters, approval blocking/provenance for risky workflow_run scripts, `/ultracode` opt-in command prompting, persisted workflow_run resume/telemetry, collision-safe save/list/read/rerun workflow lifecycle, Graft env base scratch/capture behavior, dynamic workflow status/control rendering for running/paused/failed/stale/completed runs, `/workflows` dynamic-run navigation/save, graft-isolated parallel agent refs/tool policy, and the `workflow_run` tool execution path.
