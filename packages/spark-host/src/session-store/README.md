# Spark host session-store

Pi-compatible append-only JSONL transcript storage shared by Spark host
implementations. It does not own daemon registry, mailbox, or
`session({action})` state; those remain in `@zendev-lab/spark-session`.
