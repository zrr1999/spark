# Durable execution notes (Inngest / Restate → Spark)

Status: **notes only** — no code changes in this spike. Cross-check against current Spark storage:

- `packages/spark-workflows` — workflow-run JSON stores + dynamic workflow event store
- `packages/spark-loop` — loop/goal continuation state (`active | paused | complete`)
- `packages/spark-protocol` invocation lifecycle + Cockpit SQLite `mirrored_invocations` / `invocation_events` / `invocation_log_chunks`

## What Inngest / Restate optimize for

Both treat a long-running workflow as a **deterministic function of durable step results**:

| Idea | Inngest-ish | Restate-ish |
| --- | --- | --- |
| Step barrier | `step.run(id, fn)` memoizes output | journaled handler invocations |
| Replay | After crash, skip completed steps | Replay journal; skip completed side effects |
| Sleep / wait | Durable timers / events | Durable awakeables / timers |
| Idempotency | Step id + run id | Invocation id + journal index |
| Failure | Retry policy per step; run status | Retry + suspension without losing progress |

Key property: **side effects happen once**; control flow can be replayed safely because completed steps return cached results.

## How Spark looks today (mapping)

| Durable concept | Closest Spark surface | Gap |
| --- | --- | --- |
| Run identity | Invocation id (`inv_*`), workflow run refs, dynamic workflow run refs | Multiple id namespaces; not one “execution id” across loop/workflow/turn |
| Step checkpoint | Dynamic workflow **event-sourced** store (v2); workflow-run snapshots; stage/journal entries in workflow runtime | Workflow JSON snapshots can reconcile after crash, but agent-loop *tool turns* are not step-memoized |
| Event log | `invocation_events` (+ log chunks) in Cockpit DB; protocol event cursor | Projection/mirror oriented; not a replayable execution journal for daemon turn engines |
| Pause / resume | `spark-loop` / goal `paused` + resume | Loop state is coarse (whole loop), not per-step |
| Retry | Invocation `attemptCount` / `retryOfInvocationId`; workflow parallel retry options | Retry usually restarts a turn/run rather than “continue after last durable step” |
| Sleep / wait for human | Ask/approval waits in protocol / channels | Wait is interactive, not a durable timer that survives process death with automatic resume scheduling |

Rough layering today:

```text
spark-loop     → continuation policy (keep going / pause / complete)
spark-workflows→ scripted multi-stage / multi-agent orchestration + run stores
daemon turn    → one prompt→tools→model invocation with event stream
cockpit SQLite → mirrored invocation projection for UI/history
```

None of these currently implement full **step-memoized replay** the way Restate journals do.

## 3–5 follow-ups worth doing later

1. **Introduce an explicit `execution_step` journal for daemon turns**
   Persist `{ invocationId, stepKey, kind, inputHash, output, status, finishedAt }` for tool calls and model segments. On resume/retry, skip steps whose `stepKey` already succeeded. Start behind a feature flag; keep current event stream as the UI projection.

2. **Unify “run id” vocabulary in protocol**
   Document (then enforce) one primary execution id for agent turns, with workflow-run and loop state as *parents/scopes* rather than parallel opaque ids. Map Cockpit `mirrored_invocations.runtime_invocation_id` cleanly onto that id.

3. **Promote dynamic-workflow event store patterns to saved-script workflow runs**
   The v2 event-sourced dynamic store already leans durable. Prefer append-only events + fold for orchestrator workflow runs over large mutable snapshots where crash recovery currently reconciles by “no child process ⇒ mark failed/stale”.

4. **Make loop/goal pause a durable await, not only in-memory host state**
   When a loop pauses for human review or a timer, write an await record (reason, wake condition, deadline) next to loop state so daemon restart can rehydrate and resume tick scheduling—closer to Inngest sleep/wait.

5. **Idempotent `turn.submit` with step-aware resume**
   Protocol already has optional `idempotencyKey`. Extend so a retry with the same key resumes from the last durable step instead of always forking `retryOfInvocationId` when safe. Gate on deterministic step keys from (1).

## Non-goals right now

- Do not import Inngest/Restate SDKs into Spark.
- Do not rewrite `spark-turn` agent-loop for replay in this phase.
- Do not migrate Cockpit SQLite schemas until the journal shape is spike-proven in daemon unit tests.
