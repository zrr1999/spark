# @zendev-lab/spark-session

Owns daemon-backed persistent session registry records, channel bindings/classification, the canonical `session({ action })` tool, persistent calls, and durable mailbox storage.

`session list|get` expose lifecycle, `surface: local | channel`, `activity: idle | running`, adapter bindings, and external keys. `send` defaults to an asynchronous `notification` that only persists; `kind=request` submits the exact body and defaults to `wait=accepted`. When `wait=accepted` work finishes, the daemon queues a completion-summary turn on the sender (`notifyOnCompletion`). `wait=completed` polls the durable invocation for a bounded terminal response without cancelling execution on timeout and without a second wake. To continue a timed-out wait, call `send` again with `kind=request`, `wait=completed`, and the returned `invocationId` (plus optional `timeoutMs`); this continuation path does not require target/message/payload, write mail, or call `turn.submit`. Mailbox and invocation acceptance are at least once.

Channel hosts expose only same-workspace coordination actions. Sends require a local target. Lifecycle and call actions are rejected from channel callers.

Anonymous calls belong to `role`; persistent continuity belongs to `session`. Both reuse the same headless host and `SparkAgentSession`.

See [`../../docs/specs/sessions-and-channels.md`](../../docs/specs/sessions-and-channels.md).
