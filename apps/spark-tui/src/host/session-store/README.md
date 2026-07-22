# Deprecated TUI session-store import paths

The host-neutral Pi-compatible JSONL transcript store lives at
`@zendev-lab/spark-host/session-store`. Files in this directory only preserve
the historic TUI import paths while callers migrate.

It remains distinct from `@zendev-lab/spark-session`, which owns daemon
registry, mailbox, and `session({action})` state rather than local host
transcript I/O.
