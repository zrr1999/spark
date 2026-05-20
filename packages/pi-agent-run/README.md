# pi-agent-run

Generic Pi agent run request and launch-mode helpers.

See [`../../docs/agent-run-modes.md`](../../docs/agent-run-modes.md) for when to use reusable agent specs, fresh/spec-based runs, and forked-context runs, plus safety and attribution rules.

Responsibilities:

- define `fresh | forked` launch mode types
- build Pi CLI arguments for JSON agent runs
- keep run requests tied to existing agent spec refs
- parse JSONL events from Pi output

Non-responsibilities:

- no Spark task/DAG/claim/TODO state
- no Spark artifacts or review gates
- no agent spec registry or persistence

Spark adapts these primitives in `spark-runtime`. Fresh runs are the default for Spark DAG task execution. Forked runs require an explicit `forkFromSession` parent context and should be reserved for cases where explicit artifacts or task inputs are insufficient.
