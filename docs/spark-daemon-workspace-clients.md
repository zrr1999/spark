# Spark daemon workspace client contracts

Status: implementation contract for workspace-client unification

## Purpose

Spark daemon is the owner of local workspace records and execution authority. Spark CLI/TUI, headless submitters, background executors, and the Cockpit server are clients of that daemon-owned state. The server may mirror snapshots and route commands, but it is not the owner of local workspace mutation authority.

This document fixes the contract used by protocol fixtures and downstream implementation tasks.

## Terms

- **WorkspaceRecord**: daemon-owned local record for a workspace directory. It has stable identity, canonical local path, local key, display name, optional server binding, capabilities, diagnostics, and projection metadata.
- **Workspace client**: a process or component that acquires a daemon handle for a WorkspaceRecord. Client kinds are:
  - `interactive`: a foreground Spark TUI/CLI session with a human terminal attached.
  - `headless`: a non-interactive local submitter such as `spark --print`.
  - `executor`: a background executor client that runs Spark agent work for one workspace.
- **Borrowed workspace**: a workspace with at least one connected `interactive` client. Any open TUI means borrowed. There is no focus/activity heuristic in the MVP.
- **Executor client**: the background execution client for a workspace. User-facing docs should call it the background executor where possible.
- **Snapshot-only mode**: server/cockpit may read and display daemon snapshots, but server-originated workspace mutations are rejected or disabled.

## Workspace ownership and visibility

1. The daemon owns WorkspaceRecord creation, canonical path identity, path/key conflict checks, and local mutation authority.
2. Clients acquire handles/leases; clients do not own or delete WorkspaceRecords.
3. Multiple clients may attach to the same WorkspaceRecord.
4. Implicit WorkspaceRecords are local-only. They must not be published to a server or sent as server-owned runtime bindings until an explicit register/publish action succeeds.
5. Existing registered runtime workspace binding ids remain stable. Server-side `runtime_workspace_bindings.id` is a projection/reference to the daemon binding id and must not be replaced by a client id.

## Borrowed semantics

A workspace is borrowed when:

```text
borrowed = connected interactive workspace client count > 0
```

Consequences:

- Server-originated mutating workspace commands must be rejected by the daemon while borrowed.
- Cockpit should disable or reject those mutations as an advisory UI/server guard.
- Snapshot requests, diagnostics, and explicit cancellation remain allowed when safe.
- Borrowed is not the same as paused/detached. Existing `userDetached` diagnostics represent a user-paused workspace and must not be reused for borrowed state.
- Borrowed clears only after all interactive clients release or time out their leases.

## Connection vocabulary

User-facing workspace connection status is:

```text
connected | disconnected
```

Each projection should carry `lastSeenAt` when known. Internal sweep code may keep stale session records for reconciliation, but pages and protocol projections for workspace control must not ask users to reason about a `stale` workspace state.

## Executor client state

Executor client projection is intentionally small:

```text
none | starting | online | unhealthy
```

Executor projection also carries:

- `activeInvocationCount`
- `activeAgentCount`
- `lastSeenAt` when known
- optional `unhealthyReason`

There is no executor `busy` state. Concurrent agents and invocations are allowed by default; activity counts are informational and not backpressure.

## Protocol projection fields

The runtime protocol schemas define the reusable projection shapes:

- `connection`: `{ status: "connected" | "disconnected", lastSeenAt?, reason? }`
- `workspaceClients`: client projections with `clientId`, `kind`, `status`, and timestamps
- `borrowed`: `{ borrowed, interactiveClientCount, borrowedByClientIds, since? }`
- `executor`: `{ state, clientId?, activeInvocationCount, activeAgentCount, lastSeenAt?, unhealthyReason? }`
- workspace snapshot `control`: `{ mode: "full" | "snapshot_only", reason?, serverMutationAllowed }`

These fields are required in new fixtures; migrations should repair older snapshots explicitly.

## Mutation policy

Daemon command handling is authoritative:

| Command class | Connected + not borrowed | Borrowed | Disconnected |
| --- | --- | --- | --- |
| `workspace.snapshot.request` | allow | allow | server can show last snapshot |
| `diagnostics.request` | allow | allow | server can show last snapshot |
| `invocation.cancel.request` | allow if invocation is known | allow if invocation is known | best-effort/no-op if daemon disconnected |
| `task.start.request` | allow by policy | reject `WORKSPACE_BORROWED` | reject/queue disabled by server, daemon unreachable |
| future workspace/project mutation | allow by policy | reject `WORKSPACE_BORROWED` | reject/disable |

Cockpit should mirror this policy for user experience, but correctness must live in the daemon.

## Non-goals for this slice

- No TUI inactivity auto-exit/release policy beyond lease timeout/release mechanics.
- No executor concurrency cap or busy/backpressure policy.
- No long-lived public `spark-daemon` command surface.
- No server-managed local worktree mutation authority.

## Validation expectations

- Protocol fixtures parse with workspace client, borrowed, executor, connection, and snapshot-control fields.
- Daemon store/local RPC tests prove attach/release/heartbeat and borrowed derivation.
- Daemon command tests prove borrowed mutation rejection and snapshot/cancel exceptions.
- Cockpit tests prove disabled/rejected server mutations while borrowed or disconnected.
- Grep cleanup classifies any remaining `runner`, `busy`, or `stale` hits as TUI-local wording or historical docs.
