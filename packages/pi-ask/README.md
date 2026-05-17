# pi-ask

Minimal structured `ask_user` primitive for Pi.

`pi-ask` is infrastructure: it does not depend on
`spark-core` and focuses on a small, stable protocol
for collecting human input.

## Tool

- `ask_user`

The tool supports single-select, multi-select, and
freeform questions, with optional timeout and headless
fallback.

For non-freeform questions, users can still provide
custom input directly; they are not forced through a
separate `Other / custom input…` option first.
