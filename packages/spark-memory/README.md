# @zendev-lab/spark-memory

Unified Spark memory capability for explicit, scoped memory entries and pi-memory replacement.

This package is intentionally conservative:

- `memory({ action })` is explicit; it does not silently write memories.
- Default prompt behavior is policy-only. Hosts should inject guidance about how to use memory tools, not entry bodies, unless a user opts into a cache-aware snapshot.
- Writes run a secret scanner before persistence.
- Compact/checkpoint handoff is explicit via `SparkMemoryStore.checkpoint()` and the extension wires policy-only `session_start` plus hidden `session_before_compact` checkpoint messages when the host supports extension events. The checkpoint is queued with `deliverAs: "nextTurn"` so it rides the next real user prompt instead of triggering an extra post-compaction request.
- LearningStore / `learning` tool and recall candidates live in this package; `@zendev-lab/spark-learnings` / `@zendev-lab/spark-recall` are compatibility facades (reflection still under learnings).
- If a Pi host already registered pi-memory tool names, Spark skips duplicate aliases and retries after startup so coexistence does not break Pi startup.

## Unified `memory` actions

- `remember` — record an active memory entry.
- `recall` (memory action) — list active durable entries, optionally filtered by category/query.
- `search` — keyword score active entries.
- `status` — show store path and counts.
- `forget` — mark an entry forgotten with a reason.
- `import_legacy` — preview/apply import from legacy pi-memory Markdown files. Use `apply: false` first.

## Recall candidates

`registerSparkMemoryTool` also registers the canonical `recall` tool for scoped candidates (`record_candidate` / `list` / `search` / `reject`). Storage remains `.spark/recall-candidates.json` (workspace/repo) and the user recall file under Spark user paths.

## pi-memory compatibility tools

Spark also registers compatibility aliases when the names are not already owned by `pi-memory`:

- `memory_write` — write `MEMORY.md` or append a daily log.
- `memory_read` — read `MEMORY.md`, `SCRATCHPAD.md`, one daily log, or list daily logs.
- `scratchpad` — checklist actions: `add`, `done`, `undo`, `clear_done`, `list`.
- `memory_search` — search `MEMORY.md`, `SCRATCHPAD.md`, and daily logs. `keyword` is native; `semantic`/`deep` currently degrade explicitly to keyword.
- `memory_status` — report Spark JSON memory plus compatibility Markdown file status.

## Storage

Workspace/repo entries default to `.spark/memory/memory.json`. User entries use `$SPARK_HOME/memory/memory.json` when `SPARK_HOME` is set, otherwise `${XDG_DATA_HOME:-$HOME/.local/share}/spark/memory/memory.json`.

pi-memory compatibility Markdown uses the same user memory directory and can be redirected with the tool `sourceDir` parameter when importing or interoperating with an external Pi memory directory.

Import legacy Markdown with `memory({ action: "import_legacy", apply: false })` to preview, then repeat with `apply: true` only after review. Spark skips duplicate compatibility aliases when another memory package already owns them.
