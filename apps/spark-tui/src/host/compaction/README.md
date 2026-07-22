# Native host compaction

Transcript-level compaction for Pi-compatible JSONL sessions.

## Why this stays in `apps/spark-tui` (not sunk)

| Candidate package | Why not |
| --- | --- |
| `@zendev-lab/spark-turn` | Owns **tool-result** compaction only (`compactToolResultContent`). Transcript compaction needs session entry trees, branch leaf switching, and `SparkSessionStore` mutation — turn-loop scope would widen incorrectly. |
| `@zendev-lab/spark-session` | Owns daemon **registry / mailbox / `session({action})`**, not the local Pi JSONL transcript store. `snapshot.ts` already *reads* JSONL for daemon projection; writing/compacting that format remains a host concern. |
| `@zendev-lab/spark-host` | Host-neutral ExtensionAPI runtime; pulling filesystem JSONL + Pi branch semantics would couple every host to TUI session layout. |

Split here into `types.ts` + `algorithm.ts` until a shared transcript format package exists.
