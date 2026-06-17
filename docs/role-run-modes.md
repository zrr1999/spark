# Role specs and launch modes

This document defines how Spark and `pi-roles` distinguish reusable role definitions from concrete child Pi executions.

## Vocabulary

- **Reusable RoleSpec** — a durable definition of a coding persona: ID/ref, source, description, system prompt, optional origin/metadata, and timestamps.
- **Fresh RoleRun** — a concrete execution that starts a new Pi session from an existing role plus an explicit task instruction and explicit inputs. `fresh` is the default launch mode for Spark workflow execution.
- **Forked RoleRun** — a concrete execution that still references an existing role, but launches with `launch: "forked"` from an explicit parent session/context source.

`fresh` and `forked` are runtime launch modes selected with the `launch` field. They are never role sources. `builtin`, `extension`, `project`, and `user` describe where a reusable role came from. Legacy `managed` and `predefined` terms are rejected instead of being translated at runtime.

## When to use each

### Reusable RoleSpecs

Use a reusable role when the behavior should be named, reviewed, and run more than once: for example reviewer, worker, scout, or a project/domain-specific specialist.

A role spec is not work by itself. Creating or selecting a role must not claim a task, write task-run artifacts, start a subprocess, or imply access to any parent chat/session context. A role can be used by many future runs, and each future run gets its own run identity.

Safety constraints:

- Keep roles free of secrets, live conversation state, transient task data, and machine-specific credentials.
- Persist project/user roles only after the relevant approval flow or repository policy accepts the persona and tool surface; extension roles are package-registered, not user-writable Markdown roles.
- Do not encode launch mode in the role. The same role can be launched fresh or forked by different run requests.
- Represent generated roles with metadata/origin, e.g. `origin.kind: "generated"`, not a separate source.

Attribution:

- Attribute role creation/approval to the role/proposal artifact or registry/store action.
- Use `roleRef` only to identify the definition.
- Do not use a role ref as the concrete actor that owns a task claim or produced a run output.

### Fresh RoleRuns

Use a fresh run as the default for Spark workflow-run execution and most delegated implementation, research, review, or planning work. It is best when the task can be described by a durable task description plus explicit artifacts or files.

Fresh runs provide the cleanest isolation: the child receives the chosen role and task instruction, not the parent session transcript. If context matters, pass it as a task description, input artifact, or linked file so that provenance is reviewable.

Safety constraints:

- Require an existing `roleRef`; do not launch unregistered anonymous roles.
- Pass only the context required for the task. Do not rely on hidden parent chat history.
- Keep task dependencies satisfied before scheduling the run.
- Use runtime timeouts, claim leases, and heartbeats for non-dry-run execution.
- Let `pi-roles` own generic Pi subprocess launch, cancellation, timeout signalling, stdout/stderr capture, and JSONL parsing.
- Let `spark-runtime` own single-task Spark adaptation: claims, heartbeat leases, task status transitions, artifact persistence, and Spark-specific active child process tracking.
- Let `pi-workflows` own graph-level ready task scheduling, dispatch-time executor role assignment, and workflow-run state.
- Prefer Spark-native ready-task execution over manually spawning nested `pi` processes, except when explicitly testing Pi CLI behavior.

Attribution in Spark:

- On non-dry-run scheduling, Spark creates a `TaskClaim` for the concrete run with `kind: "role-run"`.
- `claim.roleRef` is the reusable role; `claim.runName` is the human-readable concrete run instance; `claim.sessionId` is the launching/owner session; `claim.runRef` is the concrete run; and `claim.claimedBy` is the concrete claimant identity, typically derived from `sessionId + runName`.
- `TaskRun.roleRef`, `TaskRun.runName`, and `TaskRun.ownerSessionId` repeat the same distinction for run history.
- Runtime-created artifacts use `kind: "role-run"`, `producer: "task"`, `projectRef`, `taskRef`, `roleRef`, and a note containing the concrete `runName`; the body carries the concrete run record and captured stdout/stderr/events.
- When a task reaches a terminal status, the active claim is cleared and `finishedBy` preserves the owning session and concrete run name for post-completion display.

### Forked RoleRuns

Use a forked run only when the child must continue from an existing session context rather than from explicit task inputs. Examples include continuing an in-progress interactive investigation, reviewing a current session's reasoning with its transcript available, or debugging a problem whose relevant context cannot yet be compacted into artifacts.

Forked runs are not a replacement for explicit artifacts. If the needed context can be summarized or stored as an artifact, prefer a fresh run with that artifact as input.

Safety constraints:

- Require an explicit `forkFromSession` / parent context reference; never infer or silently fork a session.
- Treat a fork as exposing the parent transcript, tool outputs, and any visible sensitive context to the child run.
- Fork only sessions the launcher is allowed to share, and avoid stale or unrelated parent sessions.
- Avoid parallel forked runs that can mutate the same files or claim the same task unless Spark task dependencies and claims make the write ownership explicit.

Attribution:

- A forked run still gets its own `runRef`, `runName`, lifecycle status, stdout/stderr/events, and task claim if it is attached to a Spark task.
- `roleRef` still points to the reusable role, not the parent session.
- `pi-roles` run requests and records carry `launch: "forked"` and `forkFromSession` so consumers can audit why parent context was available.
- Spark artifacts for forked runs use the same task/run provenance as fresh runs and should additionally record the fork source in the artifact body, note, or metadata when the fork source is surfaced to Spark.
- The parent session is context provenance, not the artifact producer; the concrete child run remains the producing actor.

## Default decision rule

Default to a reusable role plus a fresh run. Create or update a reusable role when the persona should outlive the current task. Choose `forked` only when explicit artifacts are insufficient and the launcher has intentionally approved sharing the parent session context.
