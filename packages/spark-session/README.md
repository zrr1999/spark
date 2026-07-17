# @zendev-lab/spark-session

Owns daemon-backed persistent session registry records, channel bindings/classification, the canonical `session({ action })` tool, persistent calls, and durable mailbox storage.

`session list|get` expose lifecycle, `surface: local | channel`, `activity: idle | running`, adapter bindings, and external keys. `send kind=request` persists and asynchronously submits the exact body; `kind=question` submits to an idle local target and waits for a bounded terminal answer without cancelling execution on wait timeout. Mailbox and invocation acceptance are at least once.

Channel hosts expose only same-workspace coordination actions. Sends require a local target. Lifecycle and call actions are rejected from channel callers.

Anonymous calls belong to `role`; persistent continuity belongs to `session`. Both reuse the same headless host and `SparkAgentSession`.

See [`../../docs/specs/sessions-and-channels.md`](../../docs/specs/sessions-and-channels.md).
