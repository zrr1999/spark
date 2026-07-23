# spark-turn

Host-neutral model/tool turn execution for Spark hosts.

The default entry point exports `SparkAgentLoop` and its turn-facing types. Focused entry points expose behavior evaluation, privacy-safe prompt manifests, and side-thread state primitives.

## Side-thread boundary

`@zendev-lab/spark-turn/side-thread` owns the pure state reduction and handoff format for an isolated side conversation. It deliberately does not own UI widgets, persistence, model credentials, or a concrete session runner.

- The Spark daemon now owns the native child registry relation, transcript, generation/idempotency checks, read-only runner, and parent handoff. `spark-protocol` carries the cross-surface contract.
- Spark-native TUI and Cockpit consume the same daemon contract through `/btw` controls and a nested projection.
- Native code must not import `pi-coding-agent` or route the capability through `pi-extension`.

This separation keeps lifecycle invariants independent of any concrete host runtime API.
