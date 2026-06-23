# @zendev-lab/spark-protocol

Shared Spark protocol types for native TUI, daemon, and Spark Cockpit surfaces.

This package owns JSON-friendly schemas and TypeScript types for:

- refs, error envelopes, and protocol version constants;
- runtime registration plus runtime/server WebSocket envelopes and fixtures;
- cockpit projection payloads shared by daemon and Cockpit storage/API code;
- session/message/tool/run/task/artifact view models;
- interaction request/response envelopes for asks, model selection, workflow picking, confirmations, tool approvals, and diff approvals;
- view-model events that let UI hosts consume state without importing concrete renderer components.

It must not import terminal, Svelte, Pi SDK, `pi-tui`, or Spark app host internals.
