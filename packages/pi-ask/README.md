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

## Behavior comparison and adopted affordances

The local `pi-ask` / `spark-ask` flow is intentionally small, but it now
keeps the useful protocol traits observed in related Pi packages:

- `@eko24ive/pi-ask`: review tab, elaborate/re-ask flow, replay of the
  previous form, preview-aware options, and explicit continuation payloads.
- `pi-ask-user`: timeout-aware dialog fallback, split-pane previews,
  freeform input, comments, and a clear cancelled result path.
- `@juicesharp/rpiv-ask-user-question`: LLM-facing response envelopes,
  typed answer kinds, chat/custom sentinels, preview echoing, and a
  submit/review tab that can return partial answers.
- `@juicesharp/rpiv-todo`: deterministic tool envelopes whose `details`
  are the replay/persistence snapshot.
- `oh-my-pi`: currently a placeholder meta package; no ask runtime behavior
  to adopt beyond the atomized/reproducible package philosophy.

`ask_flow` results therefore include an explicit status envelope:

- `answered` — at least one answer/custom/chat/elaboration result was
  submitted.
- `timeout` — a timeout elapsed before any selection was collected.
- `cancelled` — the user cancelled the form.
- `no_selection` — the form returned without a selection and without a
  timeout signal.

Decision and approval gates must treat `timeout`, `cancelled`, and
`no_selection` as blocked, not as implicit approval.
