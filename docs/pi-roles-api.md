# `pi-roles` API design

`pi-roles` is the Spark-independent package for reusable coding roles and simple child Pi executions. It replaced the earlier split proposal for separate agent-spec and agent-run packages.

## Goals

- Make coding personas reusable by Pi features outside Spark.
- Keep reusable role definitions separate from concrete run lifecycle and launch mode.
- Use role terminology consistently: `RoleSpec` for definitions, `RoleRun` for executions.
- Provide a small API that Spark can adapt without pulling task/DAG concepts into generic Pi infrastructure.

## Non-goals

- No task graph, dependency, claim, TODO, artifact, ask, or review state.
- No Spark refs (`TaskRef`, `ArtifactRef`, Spark `RunRef`) or `spark-core` dependency.
- No cross-thread orchestration semantics.
- No capabilities/topology/delegation hierarchy in v0.1.

## Core types

```ts
export type RoleSource = "builtin" | "project" | "user";
export type RoleOriginKind = "manual" | "generated" | "imported" | "migrated" | "builtin";
export type RoleRef = `role:${string}`;
export type RoleRunRef = `run:${string}`;
export type RoleRunMode = "fresh" | "forked";

export interface RoleSpec {
   ref: RoleRef;
   id: string;
   source: RoleSource;
   description: string;
   systemPrompt: string;
   origin?: { kind: RoleOriginKind; note?: string; artifactRef?: string };
   metadata?: Record<string, unknown>;
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
   origin?: { kind: RoleOriginKind; note?: string; artifactRef?: string };
   metadata?: Record<string, unknown>;
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

Compatibility readers may import `.pi/agents/**/*.md`, `~/.pi/agent/agents/**/*.md`, and old `.spark/agents/*.json` data. These paths are migration inputs, not the target write format.

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
- `compatibilityProjectRoleStore(cwd)` → `.pi/agents` read path.
- `compatibilityUserRoleStore(home)` → `~/.pi/agent/agents` read path.
- `legacySparkJsonRoleStore(cwd)` → `.spark/agents/*.json` migration input.

## Helper API

```ts
export function createRoleRef(source: RoleSource, id: string): RoleRef;
export function builtinRoleRef(id: BuiltinRoleId): RoleRef;
export function createRoleSpec(proposal: RoleSpecProposal, now?: string): RoleSpec;
export function validateRoleSpec(role: RoleSpec): void;
export function parseRoleSpecMarkdown(markdown: string, options: { source: RoleSource }): RoleSpec;
export function serializeRoleSpecMarkdown(role: RoleSpec): string;
export function hydrateDefaultRoleRegistry(cwd?: string, home?: string): Promise<RoleRegistry>;
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

Every run references an existing role. A run can be fresh or forked regardless of whether the role source is builtin, project, or user. For usage guidance, safety constraints, and Spark attribution rules, see [agent-run-modes.md](./agent-run-modes.md).

## Spark mapping

| Spark concept / API    | `pi-roles` concept                                            |
| ---------------------- | ------------------------------------------------------------- |
| Task role binding      | `Task.roleRef` string resolved by `RoleRegistry`              |
| `spark_list_roles`     | Spark wrapper over `RoleRegistry.list()`                      |
| `spark_get_role`       | Spark wrapper over `RoleRegistry.select()`                    |
| `spark_create_role`    | Spark wrapper creating a project `RoleSpec`                   |
| Runtime task execution | `spark-runtime` calls `runRole()`                             |
| Runtime claim          | `TaskClaim.kind = "role-run"`, `roleRef`, `runName`, `runRef` |
| Runtime artifact       | `kind: "role-run"` with task/run provenance                   |

Compatibility aliases in code should be small and temporary, only to read old state or avoid breaking existing callers during rolling migration.
