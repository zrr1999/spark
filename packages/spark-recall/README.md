# spark-recall

Deprecated compatibility facade. Recall candidates and the `recall` tool now live in [`@zendev-lab/spark-memory`](../spark-memory).

Import from `@zendev-lab/spark-memory` (or `@zendev-lab/spark-memory/recall`) for new code. This package re-exports the same store and tool registration APIs.

`registerSparkMemoryTool` already registers `recall` alongside `memory`; do not load both extension entries.
