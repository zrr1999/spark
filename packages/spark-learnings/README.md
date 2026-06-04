# spark-learnings

Evidence-backed reusable learning records for Spark.

This package stores local learning records under `.learning/` (or the user learning directory) as typed records and exposes helpers for:

- recording active learnings and candidates
- searching/listing/reading learnings
- marking learnings stale, superseded, or rejected
- restoring learnings from explicit exports

Learning location is determined by storage path, not a persisted scope field: repo/workspace learnings live in `.learning/`, while user learnings live in `$PI_CODING_AGENT_DIR/learning` (default `~/.pi/agent/learning`).
