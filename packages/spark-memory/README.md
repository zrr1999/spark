# @zendev-lab/spark-memory

Unified Spark memory capability for explicit, scoped memory entries and pi-memory replacement.

This package is intentionally conservative:

- `memory({ action })` is explicit; it does not silently write memories.
- Default prompt behavior is policy-only. Hosts should inject guidance about how to use memory tools, not entry bodies, unless a user opts into a cache-aware snapshot.
- Writes run a secret scanner before persistence.
- Compact/checkpoint handoff is explicit via `SparkMemoryStore.checkpoint()` and the extension wires policy-only `session_start` plus hidden `session_before_compact` checkpoint messages when the host supports extension events.
- Existing `learning` and `recall` tools remain public compatibility surfaces; `spark-memory` provides the unifying owner direction and shared store/search primitives.
- If a Pi host already registered pi-memory tool names, Spark skips duplicate aliases and retries after startup so coexistence does not break Pi startup.

## Unified `memory` actions

- `remember` — record an active memory entry.
- `recall` — list active entries, optionally filtered by category/query.
- `search` — keyword score active entries.
- `status` — show store path and counts.
- `forget` — mark an entry forgotten with a reason.
- `import_legacy` — preview/apply import from legacy pi-memory Markdown files. Use `apply: false` first.

## pi-memory compatibility tools

Spark also registers compatibility aliases when the names are not already owned by `pi-memory`:

- `memory_write` — write `MEMORY.md` or append a daily log.
- `memory_read` — read `MEMORY.md`, `SCRATCHPAD.md`, one daily log, or list daily logs.
- `scratchpad` — checklist actions: `add`, `done`, `undo`, `clear_done`, `list`.
- `memory_search` — search `MEMORY.md`, `SCRATCHPAD.md`, and daily logs. `keyword` is native; `semantic`/`deep` currently degrade explicitly to keyword.
- `memory_status` — report Spark JSON memory plus compatibility Markdown file status.

## Storage

Workspace/repo entries default to `.spark/memory/memory.json`. User entries default to `${SPARK_MEMORY_HOME:-$XDG_DATA_HOME/spark/memory}/memory.json`.

pi-memory compatibility Markdown defaults to `${PI_MEMORY_DIR:-~/.pi/agent/memory}` and can be overridden with `SPARK_MEMORY_COMPAT_DIR` or tool `sourceDir` parameters.

## Replacement-mode migration

Safe replacement flow for this environment:

1. Keep `npm:pi-memory` installed while validating Spark coexistence.
2. Preview legacy import:
   - `memory({ action: "import_legacy", apply: false })`
3. Apply only after reviewing the preview:
   - `memory({ action: "import_legacy", apply: true, reason: "Explicit migration from pi-memory Markdown." })`
4. Run focused validation:
   - `pnpm exec node --experimental-strip-types --test test/spark-memory.test.ts`
   - `pnpm --filter @zendev-lab/spark-memory run check`
5. Run replacement smoke from the repository root:
   - `pnpm run check:daemon-readiness`
6. Only after the smoke passes, remove `npm:pi-memory` from `~/.pi/agent/settings.json` if desired.

Rollback is simply re-adding `npm:pi-memory` to the Pi package list. Spark skips duplicate compatibility tool aliases when pi-memory owns them.
