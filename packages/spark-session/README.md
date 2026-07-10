# @zendev-lab/spark-session

Daemon-owned session registry for Spark.

Owns create / list / show / bind / unbind / archive and channel binding
resolution. Transcript JSONL remains in the host session store; this package
holds the shared metadata and binding table so Cockpit Assign and IM channels
share one `sessionId` namespace.

See `docs/specs/assignment-and-channels.md`.
