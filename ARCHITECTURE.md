# Spark Package Architecture

## Naming rule

Use the dependency boundary as the naming boundary:

- `spark-*` packages depend on `spark-core` and participate in Spark-specific workflow state.
- `pi-*` packages do **not** depend on `spark-core`; they are reusable Pi infrastructure primitives.

`pi-cue`, `pi-ask`, and `pi-roles` are infrastructure, not Spark-specific workflow logic. Future packages like `pi-warp` should follow the same rule.

## Dependency direction

```text
pi-cue                 # independent Pi infrastructure
pi-ask                 # independent ask infrastructure
pi-roles               # reusable role specs and simple role-run helpers

spark-core             # refs, schemas, contracts, artifact store
  ↑
  ├─ spark-learnings
  ├─ spark/extension/spark-ask-tool ──→ pi-ask
  └─ spark-tasks
        ↑
   spark-runtime ─────→ pi-roles
        ↑
 spark-workflows ─────→ spark-runtime, pi-roles
        ↑
       spark  ───────→ pi-cue, pi-roles, spark-learnings
```

Allowed high-level usage:

- `spark` may orchestrate every Spark primitive and may use `pi-cue`, `pi-roles`, and Spark packages. It is no longer exposed as a package-level Pi extension; Spark CLI is a Spark-owned native `pi-tui` host rather than a Pi SDK `InteractiveMode` wrapper.
- `spark-core` owns shared refs, schemas, contracts, and the physical artifact store (`ArtifactStore`, `defaultArtifactStore`, metadata/blob compaction helpers).
- `spark-runtime` may combine `spark-tasks`, `pi-roles`, and `spark-core` artifacts to run one claimed task. It maps a Spark task into a `RoleRun` request and maps completion back into task status, claims, and artifacts.
- `spark-workflows` owns Spark workflow script/runtime primitives plus Spark-owned goal continuation and ready-frontier workflow-run orchestration.
- `spark-learnings` may combine `spark-core` artifact storage with learning-specific lifecycle/search/export helpers, but it must not own task scheduling or prompt injection.
- `spark-tasks` owns DAGs, TODOs, scheduling state, task names, role refs as optional plain-string executor hints, and claim leases. It must not run roles or import `pi-roles`.
- The Spark-specific ask wiring lives in `packages/spark/src/extension/spark-ask-tool.ts` and depends on `pi-ask`, but it must not provide canned question presets; Spark asks are constructed by the caller from the concrete task, blocker, review, or decision context.
- `pi-*` packages must remain generic and usable outside Spark mode.
- `RoleSpec` objects are definition-layer objects; runtime launch mode is `fresh | forked`. Do not expose legacy `managed` as a runtime-facing mode or primary source.

Forbidden dependencies:

```text
pi-cue -> spark-core
pi-ask -> spark-core
pi-roles -> spark-core
pi-cue -> spark-tasks
spark-tasks -> pi-roles
spark-tasks -> spark-runtime
spark-tasks -> spark-workflows
pi-* -> spark-*
```

## Public mental model

- Users know `/spark`.
- Reusable roles are `RoleSpec`s from `pi-roles` (`builtin`, `project`, or `user`).
- Long-lived work and claim scheduling are `spark-tasks`.
- Role execution/runtime workflow scheduling is split: generic single-run launch/control/JSONL helpers live in `pi-roles`; Spark single-task adaptation lives in `spark-runtime`; graph-level workflow and ready-frontier orchestration lives in `spark-workflows`.
- Durable context and artifact blobs are stored through `spark-core`'s artifact store.
- Evidence-backed reusable learning is `spark-learnings`.
- Execution is `pi-cue`.
- Generic human/supervisor ask mechanics are `pi-ask`.
- Spark-specific ask artifact persistence/replay lives in `packages/spark/src/extension/spark-ask-tool.ts` (consumes `pi-ask` primitives directly); concrete ask questions are generated at the call site from actual context.
- Review gates remain Spark initialization/review-flow data, not a separate package boundary.

`subagents` is not a public product concept in this repo; the Spark-side concrete child execution term is `role-run`.
