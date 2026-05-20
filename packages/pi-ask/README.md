# pi-ask

Minimal structured ask primitives for Pi.

`pi-ask` is infrastructure: it does not depend on
`spark-core` and focuses on a small, stable protocol
for collecting human input.

## Tools

- `ask_user`
- `ask_flow`

`ask_user` and `ask_flow` are peer tools over shared ask semantics.
`ask_user` is optimized for one focused question; `ask_flow` is optimized for
multi-question forms. Both use the same answer envelope and option/custom
semantics. Asks do not support automatic timeouts; they wait for an answer,
cancellation, or an explicit no-selection result from the UI adapter.

Custom text uses the same `customText` answer shape whether it comes from a
freeform question or the shared `SENTINEL_LABELS.other` custom-input sentinel.
Every select-style ask exposes a default first-class custom input affordance.
When a host provides `selectWithCustom`, business options stay separate from
the custom metadata; plain `select` adapters receive the custom row as a UI
sentinel for compatibility, never as a business option value.

## Behavior comparison and adopted affordances

The local `pi-ask` / `spark-ask` flow is intentionally small, but it now
keeps the useful protocol traits observed in related Pi packages:

- `@eko24ive/pi-ask`: review tab, elaborate/re-ask flow, replay of the
  previous form, preview-aware options, and explicit continuation payloads.
- `pi-ask-user`: split-pane previews, freeform input, comments, and a clear
  cancelled result path.
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
- `cancelled` — the user cancelled the form.
- `no_selection` — the form returned without a selection.

Decision and approval gates must treat `cancelled` and `no_selection` as
blocked, not as implicit approval.
