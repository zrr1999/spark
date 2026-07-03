# @zendev-lab/spark-memory

Unified Spark memory capability for explicit, scoped memory entries.

This package is intentionally conservative:

- `memory({ action })` is explicit; it does not silently write memories.
- Default prompt behavior is policy-only. Hosts should inject guidance about how to use memory tools, not entry bodies, unless a user opts into a cache-aware snapshot.
- Writes run a secret scanner before persistence.
- Compact/checkpoint handoff is explicit via `SparkMemoryStore.checkpoint()` and the extension wires policy-only `session_start` plus hidden `session_before_compact` checkpoint messages when the host supports extension events.
- Existing `learning` and `recall` tools remain public compatibility surfaces; `spark-memory` provides the unifying owner direction and shared store/search primitives.

## Tool actions

- `remember` — record an active memory entry.
- `recall` — list active entries, optionally filtered by category/query.
- `search` — keyword score active entries.
- `status` — show store path and counts.
- `forget` — mark an entry forgotten with a reason.

## Storage

Workspace/repo entries default to `.spark/memory/memory.json`. User entries default to `${SPARK_MEMORY_HOME:-$XDG_DATA_HOME/spark/memory}/memory.json`.
