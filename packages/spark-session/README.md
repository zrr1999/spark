# @zendev-lab/spark-session

Owns daemon-backed persistent session registry records, channel bindings/classification, the canonical `session({ action })` tool, persistent calls, and durable mailbox storage.

`session list|get` expose lifecycle, `surface: local | channel`, `activity: idle | running`, adapter bindings, and external keys. All mailbox reads and writes cross the daemon-owned `session.inbox`, `session.mail.read`, `session.mail.ack`, and `session.send` RPC boundary; extension hosts never open the mailbox store directly.

`send` defaults to an asynchronous `notification` that only persists; `kind=request` asks the daemon to persist the exact body and admit one idempotent invocation through the same RPC. The mail record keeps a pending/accepted admission receipt, so replaying `session.send` with the same idempotency key repairs a crash between mailbox persistence and invocation admission without creating a second message or invocation. `wait=accepted` queues a completion-summary turn on the sender (`notifyOnCompletion`). `wait=completed` polls the durable invocation for a bounded terminal response without cancelling execution on timeout and without a second wake. To continue a timed-out wait, call `send` again with `kind=request`, `wait=completed`, and the returned `invocationId` (plus optional `timeoutMs`); this continuation path does not require target/message/payload or another `session.send`.

Channel hosts expose only same-workspace coordination actions. Sends require a local target. Lifecycle and call actions are rejected from channel callers.

Anonymous calls belong to `role`; persistent continuity belongs to `session`. Both reuse the same headless host and `SparkAgentSession`.

See [`../../docs/specs/sessions-and-channels.md`](../../docs/specs/sessions-and-channels.md).
