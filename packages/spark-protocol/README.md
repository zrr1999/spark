# @zendev-lab/spark-protocol

Shared Spark protocol types for native TUI, daemon, and Spark Cockpit surfaces.

This package owns JSON-friendly schemas and TypeScript types for:

- refs, error envelopes, and protocol version constants;
- runtime registration plus runtime/server WebSocket envelopes and fixtures;
- cockpit projection payloads shared by daemon and Cockpit storage/API code;
- session/message/tool/run/task/artifact view models;
- interaction request/response envelopes for asks, model selection, workflow picking, confirmations, tool approvals, and diff approvals;
- view-model events that let UI hosts consume state without importing concrete renderer components;
- transport-neutral `SparkCommand` / `SparkEvent` schemas for daemon local RPC and runtime WebSocket intent/fact vocabulary.

## Command/event vocabulary

`SparkCommand` describes intent before it is delivered by a transport. Current adapters map daemon local RPC methods and runtime WebSocket `server.command` payload kinds into this vocabulary:

| Transport source | Examples | SparkCommand kind |
| --- | --- | --- |
| Local RPC turn control | `turn.submit`, `turn.cancel`, `daemon.queue` | `turn.submit.request`, `turn.cancel.request`, `turn.status.request` |
| Local RPC workspace control | `workspace.register`, `workspace.attach`, `workspace.stop` | `workspace.register.request`, `workspace.attach.request`, `workspace.stop.request` |
| Runtime WS server commands | `workspace.snapshot.request`, `task.start.request`, `invocation.cancel.request`, `diagnostics.request` | same canonical request kind |

`SparkEvent` describes facts emitted after command handling or projection ingestion. Runtime envelopes such as `runtime.command.ack`, `runtime.command.reject`, `workspace.snapshot`, `task_graph.snapshot`, `artifact.projected`, and `invocation.updated` map to command status/projection events, while diagnostics and transport errors are represented as `diagnostic.reported` / `error.reported` events with structured diagnostic details.

It must not import terminal, Svelte, Pi SDK, `pi-tui`, or Spark app host internals.
