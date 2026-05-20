# Agent specs and run modes

This document defines how Spark and the planned generic Pi agent
packages distinguish reusable agent definitions from concrete agent
executions. In Spark implementation docs, a **subagent run** means a
child Pi agent process launched by Spark runtime; it is not a separate
public product concept.

## Vocabulary

- **Reusable agent spec** — a durable definition of a persona or
  capability: ID/ref, source, description, system prompt, optional
  allowed tools, optional default model, and provenance.
- **Fresh/spec-based subagent run** — a concrete execution that starts a
  new Pi agent session from an existing spec plus an explicit task
  instruction and explicit inputs. `fresh` is the runtime mode;
  `spec-based` means the run references a reusable spec instead of
  inventing an ad hoc persona.
- **Forked-context subagent run** — a concrete execution that still
  references an existing spec, but launches in `forked` mode from an
  explicit parent session/context source.

`fresh` and `forked` are the only runtime launch modes. They are never
spec sources. `builtin`, `project`, `workspace`, and `user` describe
where a reusable spec came from; legacy `managed` language should not be
used as a run mode.

## When to use each

### Reusable agent specs

Use a reusable spec when the behavior should be named, reviewed, and run
more than once: for example planner, reviewer, worker, scout, or a
project/domain-specific specialist.

A spec is not work by itself. Creating or selecting a spec must not claim
a task, write task-run artifacts, start a subprocess, or imply access to
any parent chat/session context. A spec can be used by many future runs,
and each future run gets its own run identity.

Safety constraints:

- Keep specs free of secrets, live conversation state, temporary task
  data, and machine-specific credentials.
- Prefer least-privilege `allowedTools` and a stable, descriptive ID.
- Persist non-builtin specs only after the relevant approval flow or
  repository policy accepts the persona and tool surface.
- Do not encode launch mode in the spec. The same spec can be run fresh
  or forked by different run requests.

Attribution:

- Attribute spec creation/approval to the spec/proposal artifact or
  registry/store action.
- Use `agentRef` / `specRef` only to identify the definition.
- Do not use a spec ref as the concrete actor that owns a task claim or
  produced a run output.

### Fresh/spec-based subagent runs

Use a fresh/spec-based run as the default for Spark DAG execution and
most delegated implementation, research, review, or planning work. It is
best when the task can be described by a durable task description plus
explicit artifacts or files.

Fresh runs provide the cleanest isolation: the child receives the chosen
spec and task instruction, not the parent session transcript. If context
matters, pass it as a task description, input artifact, or linked file so
that provenance is reviewable.

Safety constraints:

- Require an existing `agentRef` / `specRef`; do not launch ad hoc
  anonymous agents.
- Pass only the context required for the task. Do not rely on hidden
  parent chat history.
- Keep task dependencies satisfied before scheduling the run.
- Use runtime timeouts, claim leases, and heartbeats for non-dry-run
  execution.
- Prefer Spark-native ready-task execution over manually spawning nested
  `pi` processes, except when explicitly testing Pi CLI behavior.

Attribution in Spark:

- On non-dry-run scheduling, Spark creates a `TaskClaim` for the
  concrete run, normally with `kind: "subagent"`.
- `claim.agentRef` is the reusable spec; `claim.agentName` is the
  human-readable concrete run instance; `claim.sessionId` is the
  launching/owner session; `claim.runRef` is the concrete run; and
  `claim.claimedBy` is the concrete claimant identity, typically derived
  from `sessionId + agentName`.
- `TaskRun.agentRef`, `TaskRun.agentName`, and `TaskRun.ownerSessionId`
  repeat the same distinction for run history.
- Agent-run artifacts are attributed to the concrete task/run output, not
  to the spec alone. Current Spark task-run artifacts use
  `kind: "agent-run"`, `producer: "task"`, `threadRef`, `taskRef`,
  `agentRef`, and a note containing the concrete `agentName`; the body
  carries the concrete run record and captured stdout/stderr/events.
- When a task reaches a terminal status, the active claim is cleared and
  `finishedBy` preserves the owning session and concrete subagent name
  for post-completion display.

### Forked-context subagent runs

Use a forked-context run only when the child must continue from an
existing session context rather than from explicit task inputs. Examples
include continuing an in-progress interactive investigation, reviewing a
current session's reasoning with its transcript available, or debugging a
problem whose relevant context cannot yet be compacted into artifacts.

Forked runs are not a replacement for explicit artifacts. If the needed
context can be summarized or stored as an artifact, prefer a fresh run
with that artifact as input.

Safety constraints:

- Require an explicit `forkFromSession` / parent context reference; never
  infer or silently fork a session.
- Treat a fork as exposing the parent transcript, tool outputs, and any
  visible sensitive context to the child run.
- Fork only sessions the launcher is allowed to share, and avoid stale or
  unrelated parent sessions.
- Avoid broad or untrusted specs when using forked context; combine forks
  with least-privilege tool access and a narrow instruction.
- Avoid parallel forked runs that can mutate the same files or claim the
  same task unless Spark task dependencies and claims make the write
  ownership explicit.

Attribution:

- A forked run still gets its own `runRef`, `agentName`, lifecycle
  status, stdout/stderr/events, and task claim if it is attached to a
  Spark task.
- `agentRef` / `specRef` still points to the reusable spec, not the
  parent session.
- Generic `pi-agent-run` records should carry `mode: "forked"` and
  `forkFromSession` so consumers can audit why parent context was
  available.
- Spark artifacts for forked runs should use the same task/run
  provenance as fresh runs and additionally record the fork source in
  the artifact body, note, or metadata. If a parent session summary or
  artifact is used as an explicit input, link it with `parent` or
  `derived-from` lineage.
- The parent session is context provenance, not the artifact producer;
  the concrete child run remains the producing actor.

## Default decision rule

Default to a reusable spec plus a fresh/spec-based run. Create or update
a reusable spec when the persona should outlive the current task. Choose
`forked` only when explicit artifacts are insufficient and the launcher
has intentionally approved sharing the parent session context.
