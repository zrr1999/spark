# @zendev-lab/spark-session

Daemon-owned persistent session registry and durable mailbox mechanism for Spark.

Owns create / list / show / bind / unbind / archive, channel binding resolution,
and local mailbox persistence. Transcript JSONL remains in the host session
store. This package holds shared session metadata and message facts so Cockpit,
channels, TUI, and the merged `role` capability share one `sessionId` namespace.

`@zendev-lab/spark-roles` exposes the public role/session tool. Keeping the
registry and mailbox here preserves the data boundary: roles are reusable
definitions; sessions are persistent execution continuity. Mailbox send does not
execute or wake a target session; persistent execution is an explicit daemon turn.

See `docs/specs/assignment-and-channels.md`.
