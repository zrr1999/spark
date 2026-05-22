# pi-ask

Minimal structured ask primitives for Pi.

`pi-ask` is infrastructure: it does not depend on
`spark-core` and focuses on a small, stable protocol
for collecting human input.

## Tools

- `ask_user`
- `ask_flow`

## Shared UX contract

`ask_user` and `ask_flow` are peer tools over shared ask semantics:

- `ask_user` is optimized for one focused question with minimal UI ceremony.
- `ask_flow` is optimized for multi-question and fullscreen review forms.
- Neither tool is a fallback for the other; both should return the same result
  envelope for the same logical answer.

Both tools follow these rules:

1. **No automatic timeout decisions.** Asks wait for an answer, explicit
   cancellation, or an explicit no-selection result from the host UI. Time
   passing must not imply approval, rejection, or cancellation.
2. **Options have separate machine and human fields.** `value` is the stable
   machine id stored in `answers[*].values`; `label` and `description` are the
   user-facing text. UI and human summaries should prefer labels/descriptions
   and must not expose raw ids as the primary visible choice text.
3. **Custom input is first-class.** Custom text uses `customText` whether it
   comes from a freeform question or the shared `SENTINEL_LABELS.other`
   affordance. Callers must not add their own business option named `Other` or
   `Type your own`. In the fullscreen flow, navigating away from `Type your own`
   preserves the draft without submitting it; Enter explicitly commits it, and
   a committed custom answer renders with the same selected affordance as a
   normal single-select option.
4. **Custom affordances are UI metadata, not business options.** Hosts that
   support `selectWithCustom` receive business option labels separately from the
   custom label. Plain `select` adapters may receive the custom row as an
   adapter-level sentinel for compatibility, but that sentinel is never returned
   as a business option id.
5. **Result status is explicit.** `answered` means the user submitted an option,
   custom text, elaboration result, or other answer payload; `cancelled` means
   the user cancelled; `no_selection` means the UI returned without a selection.
   Do not infer these from missing fields alone.
6. **Decision and approval gates require explicit option selections.** For
   decision/approval questions, `cancelled` and `no_selection` block. Submitted
   custom text is preserved as `answered` + `customText`, but the gate still
   blocks when no required option id was selected.
7. **Summaries and artifacts are shared.** `summarizeAskResult()` and
   `summarizeAskAnswers()` provide the label-first human summary for both
   `ask_user` and `ask_flow`; `createAskArtifactBody()` adds the same `summary`
   next to the structured `request` and `result` when an ask is persisted by a
   caller such as Spark.
8. **Freeform-only UI is valid.** `ask_flow` uses `input` when the request only
   needs freeform questions; lack of `select`/`selectWithCustom` must not force
   default answers when an input UI is available. Optional blank freeform
   answers may be submitted as `kind: "skipped"` so forms can advance without
   pretending the user entered text.

Spark-specific wrappers build on this contract. In particular, `spark_ask`
requires each option to provide a stable id, a short label, and a clear
human-readable description of what choosing that option means. Keep that
Spark/LLM-facing option-description validation in Spark packages; `pi-ask`
only owns generic structural validation, reserved UI labels, and ask runtime
semantics.

## Behavior comparison and adopted affordances

The local `pi-ask` / `spark-ask` flow is intentionally small, but it now
keeps the useful protocol traits observed in related Pi packages:

- `@eko24ive/pi-ask`: review tab, elaborate/re-ask flow, replay of the
  previous form, preview-aware options, and explicit continuation payloads.
- `pi-ask-user`: split-pane previews, freeform input, comments, and a clear
  cancelled result path.
- `@juicesharp/rpiv-ask-user-question`: LLM-facing response envelopes,
  typed answer kinds, custom sentinels, preview echoing, and a submit/review
  tab that can return partial answers.
- `@juicesharp/rpiv-todo`: deterministic tool envelopes whose `details`
  are the replay/persistence snapshot.
- `oh-my-pi`: currently a placeholder meta package; no ask runtime behavior
  to adopt beyond the atomized/reproducible package philosophy.

`ask_flow` results therefore include an explicit status envelope:

- `answered` — at least one answer/custom/elaboration result was submitted.
- `cancelled` — the user cancelled the form.
- `no_selection` — the form returned without a selection.

Decision and approval gates must treat `cancelled` and `no_selection` as
blocked, not as implicit approval.

## Result and persistence helpers

`pi-ask` exports shared helpers so callers do not reimplement subtly different
summaries:

- `summarizeAskResult(request, result, { blocked? })` — returns a stable,
  label-first one-line summary such as
  `Choose mode: answered; mode=Safe` or
  `Ship it? blocked: no_selection; no selection`.
- `summarizeAskAnswers(answers)` — renders one or more answers using labels
  and `customText`, while structured `values` keep the stable ids.
- `createAskArtifactBody(request, result, { blocked? })` — returns
  `{ request, result, summary }` for persistence. The structured `result`
  remains authoritative for automation; `summary` is for humans and reports.
- `createPiAskFlowArtifactBody(request, result)` — flow-specific convenience
  wrapper over the shared artifact helper.

Use these helpers for new ask tools. Do not construct custom strings that expose
raw option ids or infer result status from empty answer objects.
