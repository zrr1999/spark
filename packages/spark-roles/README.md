# spark-roles

`@zendev-lab/spark-roles` owns the canonical role/session tool, reusable coding role definitions, and anonymous single-role runs. Persistent session state remains owned by `@zendev-lab/spark-session` and the daemon; this package composes those mechanisms behind one public capability.

It deliberately does **not** own managed task graphs, task claims, artifacts,
reviews, asks, scheduler policy, or delegation topology. It owns only the
small builtin-role capability vocabulary needed to audit shipped role tool
profiles.

## Concepts

- `RoleSpec` — reusable coding role/persona definition.
- `RoleRun` — one concrete anonymous or internal role execution using a role.
- `Session` — persistent conversation continuity that can be called repeatedly and can exchange explicit durable messages.
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

`runRole()` executes a single role with `fresh | forked` mode, timeout/cancel
handling, stdout/stderr capture, tolerant JSONL parsing, and active-run control
state. Daemon-native hosts provide the executor; `spark-roles` owns the active
run registry, cancellation, and input-delivery capability reporting. A native
executor can register an input controller so follow-up text is delivered through
the host's turn queue instead of a process stdin pipe. Host packages can adapt
these primitives to task runtimes while graph-level scheduling stays outside
this package.

## Tool surface

`@zendev-lab/spark-roles` registers one public/default action tool:

- `role` with `list | get | create` manages role definitions by default; pass `resource: "session"` for persistent sessions.
- `role({ action: "call", role, instruction })` runs an anonymous role session.
- `role({ action: "call", sessionId, instruction })` submits a turn to an existing persistent session.
- `bind | unbind | archive | send | mailto | inbox | read | ack` manage persistent session bindings and messages.
- `model_list | model_get | model_set | model_delete` manage role model settings.

There is no separate public `session` tool. Role and session remain different data types behind the merged capability: roles are reusable definitions; sessions are execution continuity.

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

`role({ action: "call" })` has two explicit targets:

- `role` — launch a fresh anonymous role session; it is excluded from persistent session selectors.
- `sessionId` — submit to an existing persistent session through daemon `turn.submit`.

The targets are mutually exclusive. Internal task/reviewer/workflow role-run primitives may still use fresh/forked launch mechanics, but the public direct-call continuity path is `sessionId`.

`role({ action: "call" })` intentionally stays below managed task execution: it does not claim tasks, write task artifacts, or schedule workflow work. Host facades should route managed task execution through their task/workflow scheduler instead.
