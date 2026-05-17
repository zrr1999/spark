---
name: spark
description: Use for turning an initial or ambiguous project intent into SPARK.md, a thread/task DAG, artifacts, reviews, asks, and an agent plan through the /spark command.
---

# Spark

Use `/spark <idea>` as the single high-level entry point. Do not expose internal stages as separate user-facing commands.

Spark primitives:

- `spark-core`: shared refs and schemas.
- `spark-artifacts`: typed artifacts with provenance.
- `spark-ask`: structured decisions and approvals.
- `pi-cue`: reusable controlled execution infrastructure.
- `spark-agents`: builtin/managed agents, instruction-only runs.
- `spark-review`: verification gates.
- `spark-tasks`: thread/task DAG.

Rules:

1. A task must belong to a thread.
2. Executable tasks must bind to a builtin or managed agent.
3. Running an agent only accepts an instruction; no runtime system-prompt patching.
4. Task-generated work must be proposed and validated before persistence.
5. Store durable context as typed artifacts rather than relying on chat history.
6. Ask users to confirm output language during clarification; default the suggestion from the current request language.
7. After a decision is confirmed and the next action is clear, continue with that action instead of stopping for another permission prompt.
8. Show thread / task / TODO text summaries by default; keep `spark_status` as the full diagnostic view.
