# @zendev-lab/spark-channels

Platform channel adapters for Spark IM ingress and outbound notify.

Adapters perform I/O only: they do not run prompts or own session tables.
Inbound messages normalize to `IncomingMessage` with protocol-aligned
`externalKey` values; the daemon owns session bind/resolve and assignment.

Product surface follows pi-channels (`adapters` / `routes` / `notify` / ingress).
Production hosts wire real SDK transports; unit tests use injectable fake
transports so no live credentials are required.

See `docs/specs/assignment-and-channels.md`.
