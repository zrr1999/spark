# Sessions and channels

The daemon owns persistent conversations. TUI, Cockpit, local RPC, and channel adapters use one registry and invocation scheduler; they do not maintain parallel session state machines.

## Role and session boundary

- `role` owns reusable definitions, model settings, and fresh anonymous calls.
- `session` owns persistent identity, lifecycle, continuity, bindings, calls, and mail.

Both use the same headless host and `SparkAgentSession`. `role` must not accept lifecycle, mail, `resource=session`, or `sessionId` inputs.

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

`session({ action: "send" })` is the canonical proactive and cross-session send path. The sender is always the current session and cannot be supplied by the caller.

- `kind=request` persists an envelope, then submits the exact body as one user turn to an unarchived local session. It never scans older inbox entries and cannot target channel sessions.
- `kind=notification` persists an envelope. Channel targets also receive the body through every authoritative binding and return delivery receipts.
- `mailto` is a notification compatibility alias. Replies are notifications with `replyToMessageId`.
- New input accepts only `request | notification`; stored `inform | reply` values normalize to notification when read.
- Inbox/read/ack access only the current session. Idempotency keys are unique across mailboxes.

Mailbox persistence and invocation acceptance are an at-least-once boundary. Failure after persistence reports the stored message ID. Platform delivery has the same retry window when a receipt is lost.

## Channel policy

A channel-bound host exposes only canonical `session`. It permanently disables cue tools, `role`, `assign`, and `workflow_run`, including after extension lifecycle events. The caller may inspect and notify same-workspace sessions, request work only from an unarchived local session, and may not perform lifecycle or call actions.

Inbound adapters resolve/bind the platform conversation, submit the human body with channel origin metadata, and use their dedicated automatic reply/stream transport. Proactive platform messages use `session.send`; inbound streaming does not pass through mailbox delivery semantics.
