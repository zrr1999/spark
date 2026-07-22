# @zendev-lab/spark-memory

Unified Spark memory capability for durable entries, evidence learnings, recall candidates, and reflection pipelines.

This package is intentionally conservative:

- `memory({ action, kind? })` is the only public memory tool. `kind` is `entry` (default), `learning`, or `candidate`.
- Default prompt behavior is policy-only. Hosts should inject guidance about how to use memory tools, not entry bodies, unless a user opts into a cache-aware snapshot.
- Writes run a secret scanner before persistence.
- Compact/checkpoint handoff is explicit via `SparkMemoryStore.checkpoint()` and the extension wires policy-only `session_start` plus hidden `session_before_compact` checkpoint messages when the host supports extension events. The checkpoint is queued with `deliverAs: "nextTurn"` so it rides the next real user prompt instead of triggering an extra post-compaction request.
- A successful full compact with Smart structured details schedules background `stable_fact` and `open_item` recall candidates. Open items remain candidates; stable facts enter durable Memory only when directly associated `artifact:`/`evidence:` refs resolve locally. Review, evidence, and write failures never alter the completed compact.
- LearningStore, recall candidates, and reflection pipelines all live in this package (former `spark-learnings` / `spark-recall` packages are removed).
- If a Pi host already registered pi-memory tool names, Spark skips duplicate aliases and retries after startup so coexistence does not break Pi startup. Spark native hosts do not register these aliases unless `enablePiCompatAliases` is set.

## Unified `memory` actions

### `kind: "entry"` (default)

- `remember` — record an active memory entry.
- `recall` — list active durable entries, optionally filtered by category/query.
- `search` — keyword score active entries.
- `status` — show store path and counts.
- `forget` — mark an entry forgotten with a reason.
- `import_legacy` — preview/apply import from legacy pi-memory Markdown files. Use `apply: false` first.

### `kind: "learning"`

- `record` / `list` / `read` / `search` / `mark_stale` / `supersede` / `reject` / `export_markdown` / `import_markdown`

### `kind: "candidate"`

- `record` (alias `record_candidate`) / `list` / `search` / `reject`

## Reflection

Session reflection scan/synthesis writes under `.spark/memory/reflections/` (candidates, scan cursor, latest report). Import from `@zendev-lab/spark-memory` or the `./reflection-*` subpaths.

## pi-memory compatibility tools

Pi-memory aliases are **opt-in** via `enablePiCompatAliases: true` (the Pi product
entrypoint `extension-entry.ts` enables them; Spark native hosts leave them off).
When enabled and the names are not already owned by `pi-memory`:

- `memory_write` — write `MEMORY.md` or append a daily log.
- `memory_read` — read `MEMORY.md`, `SCRATCHPAD.md`, one daily log, or list daily logs.
- `scratchpad` — checklist actions: `add`, `done`, `undo`, `clear_done`, `list`.
- `memory_search` — search `MEMORY.md`, `SCRATCHPAD.md`, and daily logs. `keyword` is native; `semantic`/`deep` currently degrade explicitly to keyword.
- `memory_status` — report Spark JSON memory plus compatibility Markdown file status.

## Storage

User memory tree (`$SPARK_HOME/memory/` or `$XDG_DATA_HOME/spark/memory/`):

```text
memory/
├── memory.json
├── learnings/
├── recall-candidates.json
└── reflections/
```

Workspace/repo memory tree:

```text
.spark/memory/
├── memory.json
├── learnings/
├── recall-candidates.json
└── reflections/
```

`migrateSparkMemoryLayout` moves old layouts (`.learnings/`, top-level user `learnings/`, `.spark/recall-candidates.json`, `.spark/reflections/`) into this tree on `session_start` and memory tool access. Migration is idempotent: rename preferred, copy+verify on cross-device, merge/skip when targets already exist.

pi-memory compatibility Markdown uses the same user memory directory and can be redirected with the tool `sourceDir` parameter when importing or interoperating with an external Pi memory directory.

Import legacy Markdown with `memory({ action: "import_legacy", apply: false })` to preview, then repeat with `apply: true` only after review. Spark skips duplicate compatibility aliases when another memory package already owns them.
