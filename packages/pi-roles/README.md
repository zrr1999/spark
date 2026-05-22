# pi-roles

`pi-roles` owns reusable Pi coding role definitions and simple single-role runs.

It deliberately does **not** own Spark task DAGs, task claims, artifacts, reviews,
asks, scheduler policy, capabilities, or delegation topology.

## Concepts

- `RoleSpec` — reusable coding role/persona definition.
- `RoleRun` — one concrete child Pi execution using a role.
- `RoleSource` — storage/provenance scope: `builtin`, `project`, or `user`.
- `RoleOrigin` — optional metadata such as `manual`, `generated`, `imported`,
  `migrated`, or `builtin`. Generated roles are represented here rather than as
  a primary source.

## Storage

Primary Markdown role paths:

- project: `.agents/roles/**/*.md`
- user: `~/.agents/roles/**/*.md`

Compatibility read paths:

- project: `.pi/agents/**/*.md`
- user: `~/.pi/agent/agents/**/*.md`

Old Spark JSON specs under `.spark/agents/*.json` are migration input only. The
core package keeps a small loader so Spark can migrate existing projects, but new
writes use Markdown role files.

## Runtime scope

`runRole()` launches a single Pi child process with `fresh | forked` mode,
timeout/cancel handling, stdout/stderr capture, and tolerant JSONL parsing. Spark
uses these primitives from `spark-runtime` while keeping task/DAG orchestration
above this package.

## Tool surface

`pi-roles` registers role-spec management tools plus one minimal direct-call tool:

- `list_roles` — list builtin/project roles, optionally including user roles with `includeUser: true`.
- `get_role` — inspect one role; full `systemPrompt` is opt-in with `includePrompt: true`.
- `create_role` — persist a project role by default, or a user role when `source: "user"` is explicit.
- `call_role` — resolve a builtin/project/user role and call it once with an explicit instruction.

`call_role` modes:

- default / `dryRun: true` — resolve the role and return the exact Pi CLI args without launching a child process.
- `dryRun: false, mode: "fresh"` — launch a new child Pi session from the role and instruction.
- `dryRun: false, mode: "forked"` — launch with explicit parent context; requires `forkFromSession`.

`call_role` intentionally stays below Spark: it does not claim tasks, write Spark artifacts, or schedule DAG work. Use `spark_run_ready_tasks` for Spark-managed task execution.
