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
7. **Next hardening still required before declaring total parity**: persistent background run manager for generated scripts, `/workflows` TUI/control parity for script runs, real provider token/cost accounting from child role sessions, worktree isolation enforcement, approval UX, ultracode trigger/effort mode, and deep-research/adversarial-review commands wired to real web tools.

## Implemented in this change

- `pi-workflows` runtime now has deterministic metadata-first scripts, 16-concurrency default, token budget APIs, phase budgets, longest-unchanged-prefix resume, nested workflow composition, item pipelines, and the quality stdlib.
- Spark now registers `workflow_run`, a visible execution surface for generated/saved workflow scripts that routes agents through Spark workflow role-run boundaries.
- Focused tests cover runtime hardening, resume semantics, quality helpers, budget enforcement, nested workflows, and the new `workflow_run` tool execution path.
