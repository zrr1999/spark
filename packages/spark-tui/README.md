# @zendev-lab/spark-tui

Spark-owned TUI boundary over `@earendil-works/pi-tui`.

This package intentionally stays small. It centralizes:

- text measurement, truncation, and ANSI-aware wrapping;
- keyboard input parsing and key event types;
- current `pi-tui` component/runtime exports used by Spark native TUI adapters and UI-capable extensions.

It is not Spark's full UI framework and should not contain task, workflow, artifact, daemon, or cockpit business logic. Those layers should depend on shared protocols/view models or app-local adapters rather than importing `@earendil-works/pi-tui` directly.
