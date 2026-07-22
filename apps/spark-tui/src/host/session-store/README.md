# Native host session-store

Pi-compatible append-only JSONL session files under the Spark sessions root.

## Why this stays in `apps/spark-tui` (not sunk)

`@zendev-lab/spark-session` is the daemon registry/mailbox package. This module is the local host transcript I/O used by TUI bootstrap, agent-session, and CLI parity commands. Sinking would either conflate those domains or force `spark-session` to own Pi JSONL write semantics that Cockpit/daemon already project differently via `snapshot.ts`.
