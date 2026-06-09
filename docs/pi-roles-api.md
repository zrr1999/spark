# `pi-roles` API design

`pi-roles` is the Spark-independent package for reusable coding roles and simple child Pi executions. It replaces the earlier split-package direction with one generic role-spec and role-run package.

## Goals

- Make coding personas reusable by Pi features outside Spark.
- Keep reusable role definitions separate from concrete run lifecycle and launch mode.
- Use role terminology consistently: `RoleSpec` for definitions, `RoleRun` for executions.
- Provide a small API that Spark can adapt without pulling task/DAG concepts into generic Pi infrastructure.

## Non-goals

- No task graph, dependency, claim, TODO, artifact, ask, or review state.
- No task graph, artifact-store, workflow-run, or `spark-*` dependency.
- No cross-project orchestration semantics.
- No capabilities/topology/delegation hierarchy in v0.1.

## Core types

```ts
export type RoleSource = "builtin" | "project" | "user";
export type RoleOriginKind = "manual" | "generated" | "builtin";
export type RoleRef = `role:${string}`;
export type RoleRunRef = `run:${string}`;
export type RoleRunMode = "fresh" | "forked";

export interface RoleSpec {
   ref: RoleRef;
   id: string;
   source: RoleSource;
   description: string;
   systemPrompt: string;
   allowedTools?: string[];
   defaultModel?: string;
   origin?: { kind: RoleOriginKind; note?: string; artifactRef?: string };
   createdAt: string;
   updatedAt: string;
}

export interface RoleSpecProposal {
   id: string;
   source?: Exclude<RoleSource, "builtin">;
   description: string;
   systemPrompt: string;
   rationale?: string;
   expectedUses?: string[];
   allowedTools?: string[];
   defaultModel?: string;
   origin?: { kind: RoleOriginKind; note?: string; artifactRef?: string };
}

export interface RoleRunRequest {
   runRef: RoleRunRef;
   roleRef: RoleRef;
   mode?: RoleRunMode;
   instruction: string;
   forkFromSession?: string;
}
```

Generated roles use `origin.kind: "generated"`; generated is not a `RoleSource`.

## Source and storage terminology

Use `source` for role storage/provenance scope:

- `builtin` — shipped with a package or Pi distribution.
- `project` — stored in a project repo under `.agents/roles/**/*.md`.
- `user` — user-global roles under `~/.agents/roles/**/*.md`.

The builtin role set is deliberately small: `scout`, `planner`, `worker`,
`reviewer`, and `oracle`. `allowedTools` is a declarative profile on a role spec;
host or Spark preset code may consume it, but `pi-roles` does not own tool
activation or package-specific preset policy.

Runtime role loading does not read old agent-shaped paths. If a repository still has `.pi/agents`, `~/.pi/agent/agents`, or `.spark/agents/*.json` data, migrate it explicitly into `.agents/roles` before relying on `pi-roles`.

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
   constructor(rootDir: string, source?: RoleSource);
   save(role: RoleSpec): Promise<void>;
   loadAll(): Promise<RoleSpec[]>;
}
```

Helpers provide default stores:

- `defaultProjectRoleStore(cwd)` → `.agents/roles`.
- `defaultUserRoleStore(home)` → `~/.agents/roles`.

## Helper API

```ts
export function createRoleRef(source: RoleSource, id: string): RoleRef;
export function builtinRoleRef(id: BuiltinRoleId): RoleRef;
export function createRoleSpec(proposal: RoleSpecProposal, now?: string): RoleSpec;
export function validateRoleSpec(role: RoleSpec): void;
export function parseRoleSpecMarkdown(markdown: string, options: { source: RoleSource }): RoleSpec;
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
- project/user: `role:${source}-${stableId(id)}`

## Run API

```ts
export function buildRoleRunArgs(input: RoleRunCommandInput): string[];
export function runRole(input: RoleRunLauncherInput): Promise<RoleRunResult>;
export function cancelRoleRun(runRef: RoleRunRef, reason?: string): boolean;
export function listActiveRoleRuns(): ActiveRoleRun[];
export function parsePiJsonlEvents(stdout: string): unknown[];
```

Every run references an existing role. A run can be fresh or forked regardless of whether the role source is builtin, project, or user. For usage guidance, safety constraints, and Spark attribution rules, see [role-run-modes.md](./role-run-modes.md).

## Tool / Spark mapping

| Surface                      | `pi-roles` / Spark concept                                               |
| ---------------------------- | ------------------------------------------------------------------------ |
| `role({ action: "list" })`   | Pi role-spec management over `RoleRegistry.list()`                       |
| `role({ action: "get" })`    | Pi role-spec management over `RoleRegistry.select()`                     |
| `role({ action: "create" })` | Pi role-spec management creating project/user `RoleSpec`s                |
| `role({ action: "call" })`   | One-off direct role invocation; not attached to Spark tasks              |
| Spark task binding           | `Task.roleRef` string resolved by `RoleRegistry`                         |
| Spark task execution         | `spark-runtime` calls `runRole()` behind `task({ action: "run_ready" })` |
| Spark runtime claim          | `TaskClaim.kind = "role-run"`, `roleRef`, `runName`, `runRef`            |
| Spark runtime artifact       | `kind: "role-run"` with task/run provenance                              |

Runtime package boundaries should not keep compatibility aliases. Repair stale local state with explicit migration or cleanup tooling before it reaches `pi-roles`, `pi-tasks`, or `spark-runtime`.
