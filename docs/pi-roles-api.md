# `pi-roles` API design

`pi-roles` is the Spark-independent package for reusable coding roles and simple child Pi executions. It replaces the earlier split-package direction with one generic role-spec and role-run package.

## Goals

- Make coding personas reusable by Pi features outside Spark.
- Keep reusable role definitions separate from concrete run lifecycle and launch mode.
- Use role terminology consistently: `RoleSpec` for definitions, `RoleRun` for executions.
- Provide a small API that Spark can adapt without pulling task graph or workflow-run concepts into generic Pi infrastructure.

## Non-goals

- No task graph, dependency, claim, TODO, artifact, ask, or review state.
- No task graph, artifact-store, workflow-run, or `spark-*` dependency.
- No cross-project orchestration semantics.
- No open-ended capabilities/topology/delegation hierarchy; only the shipped builtin-role capability vocabulary is audited.

## Core types

```ts
export type RoleSource = "builtin" | "extension" | "project" | "user";
export type WritableRoleSource = "project" | "user";
export type RoleOriginKind = "manual" | "generated" | "builtin" | "extension";
export type RoleRef = `role:${string}`;
export type RoleRunRef = `run:${string}`;
export type RoleLaunchMode = "fresh" | "forked";

export interface RoleSpec {
   ref: RoleRef;
   id: string;
   source: RoleSource;
   description: string;
   systemPrompt: string;
   allowedTools?: string[];
   origin?: { kind: RoleOriginKind; note?: string; artifactRef?: string };
   createdAt: string;
   updatedAt: string;
}

export interface RoleSpecProposal {
   id: string;
   source?: WritableRoleSource;
   description: string;
   systemPrompt: string;
   rationale?: string;
   expectedUses?: string[];
   allowedTools?: string[];
   origin?: { kind: RoleOriginKind; note?: string; artifactRef?: string };
}

export interface RoleRunRequest {
   runRef: RoleRunRef;
   roleRef: RoleRef;
   launch?: RoleLaunchMode;
   instruction: string;
   forkFromSession?: string;
}
```

Generated roles use `origin.kind: "generated"`; generated is not a `RoleSource`.
Extension roles use `source: "extension"` and are registered by extension packages at runtime; they are not Markdown-writable project/user roles.

## Source and storage terminology

Use `source` for role storage/provenance scope:

- `builtin` — shipped with `pi-roles` / Pi distribution.
- `extension` — registered by a loaded extension package, for example `pi-graft` registering `role:extension-patcher`.
- `project` — stored in a project repo under `.agents/roles/**/*.md`.
- `user` — user-global roles under `~/.agents/roles/**/*.md`.

The builtin role set is deliberately small: `scout`, `reviewer`, and `worker`.
Builtin role `allowedTools` are derived from the audited six-token capability
vocabulary `read | write | exec | net | interact | spawn`:

| Builtin role | Capability profile       |
| ------------ | ------------------------ |
| `scout`      | `read`, `net`            |
| `reviewer`   | `read`, `net`, `exec`    |
| `worker`     | `read`, `net`, `exec`, `write` |

`record` is not a role capability; recording is covered by `write` when a future
role/tool profile explicitly grants a write surface. No builtin role receives
`interact` or `spawn`, and builtin role allowlists exclude interactive and
orchestration surfaces such as `ask`, `task`, `task_read`, `task_write`,
`goal`, `role`, `assign`, `workflow`, and `graft_patch`. Host or Spark preset code may consume
`allowedTools`, but `pi-roles` does not own package-specific activation policy.
Builtin roles report blockers, missing decisions, and unresolved ambiguities
upward in their final response.

Runtime role loading does not read old agent-shaped paths. If a repository still has `.pi/agents`, `~/.pi/agent/agents`, or `.spark/agents/*.json` data, migrate it explicitly into `.agents/roles` before relying on `pi-roles`.

Do **not** use role-spec `model` or `defaultModel` fields. Role specs define prompt, tools, rationale, and expected use; model policy lives in role model settings.

Do **not** use legacy `managed` as a source or runtime mode. It only described that Spark persisted a file; it did not tell the user where the role came from or how a run is launched.

## Registry API

```ts
export class RoleRegistry {
   constructor(initialRoles?: RoleSpec[]);
   add(role: RoleSpec): void;
   get(ref: RoleRef): RoleSpec;
   has(ref: RoleRef): boolean;
   list(filter?: { source?: RoleSource }): RoleSpec[];
   select(idOrRef: string, filter?: { source?: RoleSource }): RoleSpec;
}
```

Selection rules:

- Full `role:*` refs resolve directly.
- Plain strings match `id` or ref suffix.
- Ambiguous plain-string matches throw.
- Results are stable-sorted by source/ref/id.

## Store API

```ts
export interface RoleStore {
   save(role: RoleSpec): Promise<void>;
   loadAll(): Promise<RoleSpec[]>;
}

export class MarkdownRoleStore implements RoleStore {
   constructor(rootDir: string, source?: WritableRoleSource);
   save(role: RoleSpec): Promise<void>;
   loadAll(): Promise<RoleSpec[]>;
}
```

Helpers provide default stores:

- `defaultProjectRoleStore(cwd)` → `.agents/roles`.
- `defaultUserRoleStore(home)` → `~/.agents/roles`.

Role model settings are stored separately from role specs:

- `defaultProjectRoleModelSettingsStore(cwd)` → `.spark/role-model-settings.json`.
- `defaultUserRoleModelSettingsStore(home)` → `~/.agents/role-model-settings.json`.
- Resolution precedence is explicit run model, then project settings, then user settings.

## Helper API

```ts
export function createRoleRef(source: RoleSource, id: string): RoleRef;
export function builtinRoleRef(id: BuiltinRoleId): RoleRef;
export function createRoleSpec(proposal: RoleSpecProposal, now?: string): RoleSpec;
export function createExtensionRoleSpec(input: ExtensionRoleInput, now?: string): RoleSpec;
export function registerExtensionRole(role: RoleSpec): void;
export function hydrateExtensionRoles(registry: RoleRegistry): void;
export function validateRoleSpec(role: RoleSpec): void;
export function parseRoleSpecMarkdown(markdown: string, options: { source: WritableRoleSource }): RoleSpec;
export function serializeRoleSpecMarkdown(role: RoleSpec): string;
export function hydrateDefaultRoleRegistry(
   registry: RoleRegistry,
   cwd: string,
   options?: {
      home?: string;
      includeUser?: boolean;
   },
): Promise<void>;
```

Initial ref strategy:

- builtin: `role:builtin-${id}`
- extension: `role:extension-${id}`
- project/user: `role:${source}-${stableId(id)}`

## Run API

```ts
export function buildRoleRunArgs(input: RoleRunCommandInput): string[];
export function runRole(input: RoleRunLauncherInput): Promise<RoleRunResult>;
export function cancelRoleRun(runRef: RoleRunRef, reason?: string): boolean;
export function listActiveRoleRuns(): ActiveRoleRun[];
export function parsePiJsonlEvents(stdout: string): unknown[];
```

Every run references an existing role. A run can be fresh or forked regardless of whether the role source is builtin, extension, project, or user. For usage guidance, safety constraints, and Spark attribution rules, see [role-run-modes.md](./role-run-modes.md).

## Tool / runtime mapping

| Surface                      | `pi-roles` / runtime concept                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `role({ action: "list" })`   | Pi role-spec management over `RoleRegistry.list()`                                           |
| `role({ action: "get" })`    | Pi role-spec management over `RoleRegistry.select()`                                         |
| `role({ action: "create" })` | Pi role-spec management creating project/user `RoleSpec`s                                    |
| `role({ action: "call" })`   | One-off direct role invocation; not attached to managed task graphs or workflow runs          |
| Task executor binding        | Compatibility `Task.roleRef` string resolved by `RoleRegistry` at the host/runtime boundary  |
| Task execution               | `spark-runtime` calls `runRole()` behind explicit `assign` scheduling                         |
| Runtime claim                | Compatibility `TaskClaim.kind = "role-run"`, `roleRef`, `runName`, `runRef` attribution      |
| Runtime artifact             | Compatibility `kind: "role-run"` records with task/run provenance                            |

Runtime package boundaries should not keep compatibility aliases. Repair stale local state with explicit migration or cleanup tooling before it reaches `pi-roles`, `pi-tasks`, or `spark-runtime`.
