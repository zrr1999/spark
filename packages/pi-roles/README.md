# pi-roles

`pi-roles` owns reusable Pi coding role definitions and simple single-role runs.

It deliberately does **not** own Spark task DAGs, task claims, artifacts, reviews,
asks, scheduler policy, capabilities, or delegation topology.

## Concepts

- `RoleSpec` — reusable coding role/persona definition.
- `BuiltinRoleProvider` — package-owned predefined role contribution hook.
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
in `spark-workflows` above this package.

## Tool surface

`pi-roles` registers role-spec management tools plus one minimal direct-call tool:

- `list_roles` — list builtin/project roles, optionally including user roles with `includeUser: true`.
- `get_role` — inspect one role; full `systemPrompt` is opt-in with `includePrompt: true`.
- `create_role` — persist a project role by default, or a user role when `source: "user"` is explicit.
- `call_role` — resolve a builtin/project/user role and call it once with an explicit instruction.

Package-specific extensions can register predefined roles through the builtin
role provider hook. `pi-roles` owns the registry mechanism; the contributing
package owns any domain semantics in those role prompts.

`call_role` modes:

- default / `mode: "fresh"` — launch a new child Pi session from the role and instruction.
- `mode: "forked"` — launch with explicit parent context; requires `forkFromSession`.

`call_role` intentionally stays below Spark: it does not claim tasks, write Spark artifacts, or schedule DAG work. Use `spark_run_ready_tasks` for Spark-managed task execution.
