# @zendev-lab/spark-protocol

Shared Spark protocol types for native TUI, daemon, and Web cockpit surfaces.

This package owns JSON-friendly schemas and TypeScript types for:

- session/message/tool/run/task/artifact view models;
- interaction request/response envelopes for asks, model selection, workflow picking, confirmations, tool approvals, and diff approvals;
- view-model events that let UI hosts consume state without importing concrete renderer components.

It must not import terminal, Svelte, Pi SDK, `pi-tui`, or Spark CLI host internals.
