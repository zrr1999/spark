# spark-roles

`@zendev-lab/spark-roles` owns reusable Pi coding role definitions and simple single-role runs.

It deliberately does **not** own managed task graphs, task claims, artifacts,
reviews, asks, scheduler policy, or delegation topology. It owns only the
small builtin-role capability vocabulary needed to audit shipped role tool
profiles.

## Concepts

- `RoleSpec` — reusable coding role/persona definition.
- `RoleRun` — one concrete child Pi execution using a role.
- `RoleSource` — storage/provenance scope: `builtin`, `extension`, `project`, or `user`.
- `RoleOrigin` — optional metadata such as `manual`, `generated`, `builtin`, or `extension`.
  Generated roles are represented here rather than as a primary source.

## Storage

Primary Markdown role paths:

- project: `.agents/roles/**/*.md`
- user: `~/.agents/roles/**/*.md`

Extension roles are registered by loaded extension packages at runtime and are not writable Markdown store entries.

Agent-shaped paths and refs are not accepted inputs. Repair stale
local state explicitly before loading it; new writes use Markdown role files.

Role specs do not carry model policy. Markdown frontmatter with `model` or
`defaultModel` is rejected; store model choices separately instead:

- project: host-owned `RoleModelSettingsStore` path; the exported default reads `.spark/role-model-settings.json`
- user: `~/.agents/role-model-settings.json`

Resolution order is explicit run model, then project settings, then user
settings. There is no legacy binding fallback.

## Runtime scope

`runRole()` launches a single Pi child process with `fresh | forked` mode,
timeout/cancel handling, stdout/stderr capture, and tolerant JSONL parsing. Host
packages can adapt these primitives to task runtimes while graph-level scheduling
stays outside this package.

## Tool surface

`@zendev-lab/spark-roles` registers one public/default action tool:

- `role` — use `action: "list" | "get" | "create" | "call"` to list roles, inspect a role, create a role, or run one direct role call.
- `role` — use `action: "model_list" | "model_get" | "model_set" | "model_delete"` to inspect, save, or delete project/user role model settings.

Historical fragmented implementation functions may remain internal dispatch targets behind `role`, but they are not active public/default tools.

Builtin roles are the core three role shapes: `scout`, `reviewer`, and
`worker`. Their `allowedTools` fields are derived from the audited six-token
capability vocabulary `read | write | exec | net | interact | spawn`:

- `scout = read + net`
- `reviewer = read + net + exec`
- `worker = read + net + exec + write`

`record` is not a role capability; recording is treated as `write` where a
future role/tool profile explicitly grants a write surface. No builtin role
receives `interact` or `spawn`, and builtin role tool allowlists exclude
interactive and orchestration tools such as `ask`, `task`, `task_read`,
`task_write`, `goal`, `role`, `assign`, `workflow`, and `graft_patch`. Builtin roles report blockers, missing
decisions, and unresolved ambiguities upward in their final response.

`role({ action: "call" })` launch modes:

- default / `launch: "fresh"` — launch a new child Pi session from the role and instruction.
- `launch: "forked"` — launch with explicit parent context; requires `forkFromSession`.

`role({ action: "call" })` intentionally stays below managed task execution: it does not claim tasks, write task artifacts, or schedule workflow work. Host facades should route managed task execution through their task/workflow scheduler instead.
