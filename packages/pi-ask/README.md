# pi-ask

Minimal structured ask primitives for Pi.

`pi-ask` is infrastructure: it does not depend on
`spark-core` and focuses on a small, stable protocol
for collecting human input.

## Tools

- `ask_user`
- `ask_flow`

`ask_user` supports single-select, multi-select, and
freeform questions, with optional timeout and headless
fallback. `ask_flow` adds the reusable multi-question
flow state machine, renderer, replay helpers, payload
store, and settings used by domain packages.

For non-freeform questions, users can still provide
custom input directly; they are not forced through a
separate `Other / custom input…` option first.
