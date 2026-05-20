# `pi-agent-spec` API design

`pi-agent-spec` is the proposed Spark-independent package for defining, validating, selecting, and persisting agent specifications. It should not depend on `spark-core` or any Spark package.

## Goals

- Make agent personas/capabilities reusable by Pi features outside Spark.
- Keep specs separate from concrete run lifecycle and launch mode.
- Replace public `managed` terminology with provenance/source terminology.
- Provide a small API that Spark can adapt without pulling task/DAG concepts into generic Pi infrastructure.

## Non-goals

- No task graph, dependency, claim, TODO, artifact, ask, or review state.
- No process spawning or runtime launch modes; that belongs in `pi-agent-run`.
- No Spark refs (`AgentRef`, `RunRef`, `ArtifactRef`) or `spark-core` dependency.
- No cross-thread orchestration semantics.

## Core types

```ts
export type AgentSpecSource = "builtin" | "project" | "workspace" | "user";

export type AgentSpecRef = `agent:${string}`;

export interface AgentSpec {
   ref: AgentSpecRef;
   id: string;
   source: AgentSpecSource;
   description: string;
   systemPrompt: string;
   allowedTools?: string[];
   defaultModel?: string;
   metadata?: Record<string, unknown>;
   createdAt: string;
   updatedAt: string;
}

export interface AgentSpecProposal {
   id: string;
   source?: Exclude<AgentSpecSource, "builtin">;
   description: string;
   systemPrompt: string;
   rationale?: string;
   expectedUses?: string[];
   allowedTools?: string[];
   defaultModel?: string;
   metadata?: Record<string, unknown>;
}
```

`AgentSpecRef` deliberately remains a simple string ref so Spark can map it to existing `agent:*` refs during migration. It should be owned by `pi-agent-spec`, not imported from `spark-core`.

## Source terminology

Use `source`, not `scope`, for public spec provenance:

- `builtin` — shipped with a package or Pi distribution.
- `project` — stored in a project/workspace repo, e.g. `.spark/agents` during migration or future `.pi/agents`.
- `workspace` — local workspace-level specs that are not intended as user-global defaults.
- `user` — user-global reusable specs.

Do **not** use `managed` as a source or runtime mode. `managed` only described that Spark persisted a JSON file; it does not tell the user where the spec came from or how a run is launched.

## Registry API

```ts
export class AgentSpecRegistry {
   constructor(initialSpecs?: AgentSpec[]);
   add(spec: AgentSpec): void;
   get(ref: AgentSpecRef): AgentSpec;
   has(ref: AgentSpecRef): boolean;
   list(filter?: { source?: AgentSpecSource }): AgentSpec[];
   select(idOrRef: string, filter?: { source?: AgentSpecSource }): AgentSpec;
}
```

Selection rules:

- Full `agent:*` refs resolve directly.
- Plain strings match `id` or ref suffix.
- Ambiguous plain-string matches throw.
- Results are stable-sorted by `id`, then `source`, then `ref`.

## Store API

```ts
export interface AgentSpecStore {
   save(spec: AgentSpec): Promise<void>;
   loadAll(): Promise<AgentSpec[]>;
   delete?(ref: AgentSpecRef): Promise<boolean>;
}

export class JsonAgentSpecStore implements AgentSpecStore {
   constructor(options: { rootDir: string; writableSources?: AgentSpecSource[] });
   save(spec: AgentSpec): Promise<void>;
   loadAll(): Promise<AgentSpec[]>;
   delete(ref: AgentSpecRef): Promise<boolean>;
   pathFor(ref: AgentSpecRef): string;
}
```

Store policy:

- `builtin` specs are usually code-provided and should not be saved by a JSON store unless explicitly allowed.
- File names should be based on ref/id-stable slugs, not raw user text.
- Validate loaded specs and either skip invalid files with diagnostics or throw in strict mode.

## Helper API

```ts
export function createAgentSpecRef(source: AgentSpecSource, id: string): AgentSpecRef;
export function createAgentSpec(proposal: AgentSpecProposal, now?: string): AgentSpec;
export function validateAgentSpec(spec: AgentSpec): void;
export function normalizeAgentSpecSource(value: unknown): AgentSpecSource | undefined;
```

Initial ref strategy can preserve current Spark shape:

- builtin: `agent:builtin-${id}`
- project/workspace/user: `agent:${source}-${stableId(id)}`

This keeps existing `agent:builtin-worker` style familiar while avoiding Spark-owned ref helpers.

## Spark migration mapping

| Current Spark type / API                       | Target `pi-agent-spec`                                              |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `spark-core.AgentSpec`                         | `pi-agent-spec.AgentSpec`                                           |
| `AgentSpec.source = "predefined" \| "project"` | `AgentSpecSource = "builtin" \| "project" \| "workspace" \| "user"` |
| `spark-agents.AgentRegistry`                   | `pi-agent-spec.AgentSpecRegistry`                                   |
| `ProjectAgentSpecStore`                        | `JsonAgentSpecStore` configured for `project` or `workspace`        |
| `createAgentSpec`                              | `createAgentSpec({ source: "project", ... })`                       |
| `spark_list_agent_specs`                       | Spark wrapper over `AgentSpecRegistry.list()`                       |
| `spark_get_agent_spec`                         | Spark wrapper over `AgentSpecRegistry.select()`                     |
| `spark_create_agent_spec`                      | Spark wrapper creating a non-builtin agent spec                     |

Compatibility should be small and temporary. If existing `.spark/agents/*.json` files contain `scope: "managed"`, load-time migration can map it to `source: "project"` and rewrite on explicit save.

## Relationship to `pi-agent-run`

`pi-agent-spec` has no runtime mode field. `fresh` and `forked` are fields on run requests in `pi-agent-run`:

```ts
export interface AgentRunRequest {
   specRef: AgentSpecRef;
   mode: "fresh" | "forked";
   instruction: string;
}
```

Every run references an existing spec. A run can be fresh or forked regardless of whether the spec source is builtin, project, workspace, or user. For usage guidance, safety constraints, and Spark attribution rules for reusable specs, fresh/spec-based runs, and forked-context runs, see [agent-run-modes.md](./agent-run-modes.md).

## Minimal implementation plan

1. Add `packages/pi-agent-spec` with the types and registry/store helpers above.
2. Port builtin Spark specs to use `pi-agent-spec` types, but keep Spark-specific prompts in Spark code until a generic builtin catalog exists.
3. Update `spark-runtime` and `spark` extension to consume spec refs through an adapter layer.
4. Keep public Spark tools on spec terminology, with old managed-agent tool names only as transitional aliases if necessary.
5. Remove agent spec/run types from `spark-core` once Spark code imports the generic package.
