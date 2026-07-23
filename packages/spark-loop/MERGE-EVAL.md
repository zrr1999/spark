# spark-loop / spark-repro ↔ spark-host merge evaluation (Phase 5 task 19)

Date: 2026-07-21

## Verdict

| Package | Merge into `spark-host`? | Reason |
| --- | --- | --- |
| `spark-loop` | **No (keep separate)** | ~1.8k LoC of session goal/loop/identity/directory store primitives with many spark-extension + root-test consumers. Boundary is clear (continuation substrate, no host runtime / `SparkHostAPI` registration). Folding into host would inflate the host package and blur “host services” vs “session continuation state”. |
| `spark-repro` | **Skipped this pass** | User WIP currently modifies `packages/spark-repro/**` plus related session/daemon/spark-extension files. Do not merge while that work is in flight. Separately: repro is already a published leaf used by `spark-host` (widget controller) and spark-extension adapters; keeping it leaf-sized preserves mutation-CE coverage and publish surface. |

## When to revisit

- Repro: after WIP lands, re-check whether the state machine stays host-neutral enough to remain a leaf, or whether only the widget glue belongs in host.
- Loop: only if a future host-support extraction needs goal/loop types co-located with ExtensionAPI runtime *and* consumer count shrinks to host-only.
