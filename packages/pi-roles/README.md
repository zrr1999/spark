# pi-roles

`pi-roles` owns reusable Pi coding role definitions and simple single-role runs.

It deliberately does **not** own Spark task DAGs, task claims, artifacts, reviews,
asks, scheduler policy, capabilities, or delegation topology.

## Concepts

- `RoleSpec` — reusable coding role/persona definition.
- `RoleRun` — one concrete child Pi execution using a role.
- `RoleSource` — storage/provenance scope: `builtin`, `project`, or `user`.
- `RoleOrigin` — optional metadata such as `manual`, `generated`, or `builtin`.
  Generated roles are represented here rather than as a primary source.

## Storage

Primary Markdown role paths:

- project: `.agents/roles/**/*.md`
- user: `~/.agents/roles/**/*.md`

Legacy agent-shaped paths and refs are not compatibility inputs. Repair stale
local state explicitly before loading it; new writes use Markdown role files.

## Runtime scope

`runRole()` launches a single Pi child process with `fresh | forked` mode,
timeout/cancel handling, stdout/stderr capture, and tolerant JSONL parsing. Spark
uses these primitives from `spark-runtime` and keeps graph-level task orchestration
in `pi-workflows` above this package.

## Tool surface

`pi-roles` registers one public/default action tool:

- `role` — use `action: "list" | "get" | "create" | "call"` to list roles, inspect a role, create a role, or run one direct role call.

Historical fragmented implementation functions may remain internal dispatch targets behind `role`, but they are not active public/default tools.

Builtin roles are the core five role shapes: `scout`, `planner`, `worker`,
`reviewer`, and `oracle`. Their `allowedTools` fields are declarative tool
profiles for hosts or presets to consume; `pi-roles` itself does not own
host-level tool activation policy.

`role({ action: "call" })` modes:

- default / `mode: "fresh"` — launch a new child Pi session from the role and instruction.
- `mode: "forked"` — launch with explicit parent context; requires `forkFromSession`.

`role({ action: "call" })` intentionally stays below Spark: it does not claim tasks, write Spark artifacts, or schedule DAG work. Use `task({ action: "run_ready" })` for Spark-managed task execution.
