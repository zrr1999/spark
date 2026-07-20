# Sessions and channels

The daemon owns persistent conversations. TUI, Cockpit, local RPC, and channel adapters use one registry and invocation scheduler; they do not maintain parallel session state machines.

## Role and session boundary

- `role` owns reusable definitions, model settings, and fresh anonymous calls.
- `session` owns persistent identity, lifecycle, continuity, bindings, calls, and mail.

Both use the same headless host and `SparkAgentSession`. `role` must not accept lifecycle, mail, `resource=session`, or `sessionId` inputs.

Local role-managed sessions are named by division of labour, not by the task currently in flight. The registry's `role` field is the canonical stable responsibility and `title` is its compatibility display mirror. Agent-created local sessions must provide that role at creation and reuse the matching session for later tasks. A user-created local session may begin unassigned; its first completed user turn classifies one reusable role and compare-and-set persists both fields. Concrete task text belongs only in `session call` or `session send`.

Message-platform channel sessions are outside generic role management. Message-platform settings own their creation policy, technical identity title, binding, credentials, and retirement; generic first-turn role classification must ignore channel-bound or platform-titled sessions.

## Registry projection

Lifecycle status is `ready | running | archived`. `session list|get` also expose:

- `surface: local | channel`, derived from authoritative channel bindings;
- `activity: idle | running`, projected without changing lifecycle status;
- adapter IDs, external keys, bindings, and workspace or daemon scope.

Registry records and bindings are authoritative. Adapter liveness comes from daemon `channel.status`.

## Message origin

Every daemon user message carries hidden metadata:

```ts
type SparkSessionMessageOrigin = {
  kind: "user" | "session";
  host: "tui" | "web" | "channel" | "daemon" | "session";
  sessionId?: string;
  surface: "local" | "channel";
  adapter?: string;
  externalKey?: string;
  senderId?: string;
};
```

The visible user content remains the exact human/request body. Origin and mail-envelope fields are audit metadata, not authorization inputs.

## Mail

`session({ action: "send" })` is the canonical cross-session send path. The sender is always the current session and cannot be supplied by the caller.

- `kind=request` persists an envelope, then asynchronously submits the exact body as one user turn to an unarchived local session. It may wait behind work already active for that session, never scans older inbox entries, and cannot target channel sessions.
- `kind=question` persists and submits the exact body to an idle, unarchived local session, then waits 1–300 seconds for the terminal result. The default is 120 seconds. Wait timeout stops only the sender wait; the target invocation continues. Questions cannot nest or form a session loop; delegated work uses `request`.
- New input accepts only `request | question`; `request` is the default. Historical stored notification/inform/reply envelopes remain readable but cannot be sent through the public session tool.
- Inbox/read/ack access only the current session. Idempotency keys are unique across mailboxes.

Mailbox persistence and invocation acceptance are an at-least-once boundary. Failure after persistence reports the stored message ID. Platform delivery has the same retry window when a receipt is lost. Question idle admission is atomic in the daemon invocation store; only one concurrent question can reserve an idle target.

## Channel policy

A channel-bound host exposes only canonical `session`. It permanently disables cue tools, `role`, `assign`, and `workflow_run`, including after extension lifecycle events. The caller may inspect same-workspace sessions, request work only from an unarchived local session, and may not perform lifecycle or call actions.

Inbound adapters first persist a normalized, raw-payload-free receipt in the daemon SQLite ledger. A leased worker then resolves/binds the platform conversation and submits the exact human body with channel origin metadata. `(workspace, adapter, externalKey, platformMessageId)` produces a stable hashed identity, so platform replay and overlapping restart generations converge on one invocation. Messages whose platform supplies no ID remain at-least-once.

The invocation terminal transition and its final/failure reply intent commit in one SQLite transaction. Final replies, native asks, interaction acknowledgements, and inbound receipts share a leased worker with token fencing, lease heartbeats, concurrent independent attempts, a three-minute per-attempt application deadline, jittered exponential backoff capped at 60 seconds, and no attempt-count limit. A stuck third-party call therefore cannot head-of-line block unrelated deliveries. Every failed or timed-out attempt is logged and projected by `daemon.status`; delivered work is never reclaimed. A crashed running invocation is failed closed and atomically queues a channel-visible failure notice instead of replaying the model turn.

Streaming cards are progress projections only. Their start/update/finish calls are best effort and never block the durable final answer. Platform sends are at-least-once: adapters must carry stable platform identities where supported, while an ambiguous timeout on a platform without a client idempotency field can produce a duplicate rather than silent loss. Historical proactive-message receipts remain durable for audit and retry reconciliation, but `session.send` no longer creates notification deliveries.

External channel handshakes are supervised health, not daemon readiness gates. Infoflow and QQ arm their connectors and return immediately, then retry initial connection, disconnects, missing Gateway Hello, and missed heartbeat acknowledgements with capped backoff and no attempt limit. An inbound platform sequence/message is marked consumed only after the daemon's synchronous SQLite receipt succeeds; receipt failure closes the connection before acknowledgement so platform redelivery can resume from the last durable cursor.

QQ Gateway resume state is stored in daemon SQLite by `(workspaceId, adapterId)`. A rebuilt transport loads the prior `sessionId` and sequence before connecting; `READY`, `RESUMED`, message, and interaction sequences advance only after their durable handler succeeds, and an invalid-session response clears the cursor. A sequence for the same gateway session can never move backwards.
