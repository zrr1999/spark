# @zendev-lab/spark-protocol

JSON-safe schemas and types shared by native TUI, daemon, runtime WebSocket, and Cockpit surfaces. This package owns refs/errors, command/event envelopes, invocation lifecycle, registration, projections, interactions, and view models.

Local RPC turn methods map to `turn.submit.request`, `turn.status.request`, `turn.stream.subscribe`, and `turn.cancel.request`. Runtime commands map to the same transport-neutral `SparkCommand` vocabulary. Facts use `SparkEvent`, including command status/rejection, projections, diagnostics, and errors.

The package must not import terminal, Svelte, Pi SDK, `pi-tui`, or Spark app internals. See [`../../docs/specs/turn.md`](../../docs/specs/turn.md).
