# pi-roles

`@zendev-lab/pi-roles` owns reusable Pi coding role definitions and simple single-role runs.

It deliberately does **not** own managed task graphs, task claims, artifacts,
reviews, asks, scheduler policy, capabilities, or delegation topology.

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

Role specs do not carry model policy. Markdown frontmatter with `model` or
`defaultModel` is rejected; store model choices separately instead:

- project: host-owned `RoleModelSettingsStore` path; the exported default still reads `.spark/role-model-settings.json` for compatibility
- user: `~/.agents/role-model-settings.json`

Resolution order is explicit run model, then project settings, then user
settings. There is no legacy binding fallback.

## Runtime scope

`runRole()` launches a single Pi child process with `fresh | forked` mode,
timeout/cancel handling, stdout/stderr capture, and tolerant JSONL parsing. Host
packages can adapt these primitives to task runtimes while graph-level scheduling
stays outside this package.

## Tool surface

`@zendev-lab/pi-roles` registers one public/default action tool:

- `role` — use `action: "list" | "get" | "create" | "call"` to list roles, inspect a role, create a role, or run one direct role call.
- `role` — use `action: "model_list" | "model_get" | "model_set" | "model_delete"` to inspect, save, or delete project/user role model settings.

Historical fragmented implementation functions may remain internal dispatch targets behind `role`, but they are not active public/default tools.

Builtin roles are the core five role shapes: `scout`, `planner`, `worker`,
`reviewer`, and `oracle`. Their `allowedTools` fields are declarative tool
profiles for hosts or presets to consume; `@zendev-lab/pi-roles` itself does not own
host-level tool activation policy.

`role({ action: "call" })` modes:

- default / `mode: "fresh"` — launch a new child Pi session from the role and instruction.
- `mode: "forked"` — launch with explicit parent context; requires `forkFromSession`.

`role({ action: "call" })` intentionally stays below managed task execution: it does not claim tasks, write task artifacts, or schedule workflow work. Host facades should route managed task execution through their task/workflow scheduler instead.
