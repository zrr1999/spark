# @zendev-lab/spark-session

Daemon-owned persistent session registry and durable mailbox mechanism for Spark.

Owns the canonical `session({ action })` tool, create/list/get/bind/unbind/archive,
local-vs-channel classification, channel binding resolution, daemon-backed
persistent calls, and local mailbox persistence. Transcript JSONL remains in the
shared host session store.

`session list` projects `surface: local | channel`, `channelAdapters`, and
`externalKeys`, and supports surface/adapter/workspace/archive filters. Mailbox
send does not execute or wake a target session; persistent execution is an explicit
daemon turn. Anonymous `role call` and persistent `session call` expose different
continuity semantics while reusing the same headless host and `SparkAgentSession`.

Message-platform sessions are coordination-only: the host activates only the
canonical `session` tool, which permits read/mail coordination actions only.
Listing and targets are restricted to the current workspace, lifecycle and call
actions are rejected, and execution requests must be forwarded with `session send`
to a `surface=local` persistent session.

See `docs/specs/assignment-and-channels.md`.
