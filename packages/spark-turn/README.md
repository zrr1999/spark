# spark-turn

Host-neutral model/tool turn execution for Spark hosts.

The default entry point exports `SparkAgentLoop` and its turn-facing types. Focused entry points expose behavior evaluation, privacy-safe prompt manifests, and side-thread state primitives.

## Side-thread boundary

`@zendev-lab/spark-turn/side-thread` owns the pure state reduction and handoff format for an isolated side conversation. It deliberately does not own UI widgets, persistence, model credentials, or a concrete session runner.

- `packages/pi-btw` maps Pi custom entries and its Pi sub-session into this contract as a frozen compatibility adapter.
- The Spark daemon now owns the native child registry relation, transcript, generation/idempotency checks, read-only runner, and parent handoff. `spark-protocol` carries the cross-surface contract.
- Spark-native TUI consumes that contract through one `/btw` command, and Cockpit exposes a nested read-only projection. The current TUI slice is command/status output, not a Pi-style modal overlay.
- Native code must not import `pi-coding-agent` or route the capability through `pi-extension`.

This separation lets the Pi and Spark-native hosts share lifecycle invariants without forcing either host to emulate the other's runtime API.
