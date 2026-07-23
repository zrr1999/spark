# @zendev-lab/spark-daemon-client

Protocol-aware transport for calling the local Spark daemon.

This package owns socket client lifecycle, daemon transport errors, and oRPC
method dispatch. Domain request/result contracts remain in
`@zendev-lab/spark-protocol`; generic filesystem and socket adapter primitives
remain in `@zendev-lab/spark-system`.
