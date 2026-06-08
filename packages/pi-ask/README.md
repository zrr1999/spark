# pi-ask

Minimal structured ask primitives for Pi.

`pi-ask` is infrastructure: it does not depend on
`spark-*` packages and focuses on a small, stable protocol
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
   custom label. Plain `select` adapters receive only business option labels;
   they do not get a synthetic custom row.
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

Spark-specific wrappers build on this contract. In particular, Spark's canonical `ask`
facade requires each option to provide a stable id, a short label, and a clear
human-readable description of what choosing that option means. Keep that
Spark/LLM-facing option-description validation in Spark packages; `pi-ask`
only owns generic structural validation, reserved UI labels, and ask runtime
semantics.

## Behavior comparison and adopted affordances

The local `pi-ask` flow is intentionally small, but it now
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

## Copilot-style ask UX review

The Copilot ask screenshot is useful because it shows a form as an explicit
information gate, not just a select menu. Current `pi-ask` now adopts the parts
that fit a terminal-first UI:

Concrete observations from the current renderer/tests:

1. **Request identity is explicit.** `renderAskScreen()` receives request
   `mode` and renders a top banner such as `Pi is requesting a decision` before
   the ask-specific title/context. This maps to
   `packages/pi-ask/src/ui/render.ts` and is covered by
   `ask flow render shows mode-aware request banner`.
2. **Long explanatory copy remains readable.** Title, context, prompt, option
   description, answer, notes, and review rows use width-aware wrapping. The
   narrow-width regression at width 48 checks that long title/context/prompt and
   option-description fragments remain visible.
3. **Decision-dimension tabs survive narrow terminals.** The tab bar wraps tab
   parts across rows instead of truncating the whole row. The Chinese regression
   with `替代方案落点`, `必须覆盖的功能范围`, and `兼容策略` checks active brackets,
   answered checkmarks, review tab visibility, and width <= 60.
4. **Footer hints are current-mode specific.** The footer now distinguishes
   multi-select (`Space toggle`), custom/freeform (`Type directly`), and submit
   (`1=Submit · 2=Elaborate · 3=Cancel`) states instead of always showing a
   generic navigation string.
5. **Checkbox clarity is already adequate.** Multi-select uses checked and
   unchecked glyphs with a separate focus marker, matching the important part of
   the Copilot checklist without requiring a boxed layout.

Prioritized backlog:

Immediate / next implementation:

- Add a small render fixture helper for future UI reviews so screenshots/snippets
  can be generated from representative asks without duplicating test setup.

Later / optional:

- Consider a compact actor label if Spark wants `Spark is requesting ...` rather
  than fixed `Pi is requesting ...`. Keep this facade-level if possible; avoid a
  broad schema field until there are multiple real actors.
- Revisit visual separators only if real asks still feel dense after the banner,
  wrapped context, wrapped tabs, and concise footer changes.

Reject / defer:

- Do not copy Copilot's full bordered card as a requirement. Borders consume
  width, complicate narrow terminal wrapping, and do not improve the structured
  answer protocol.
- Do not add scroll/pagination state for tabs yet. Wrapped rows handle the 2-4
  question decision forms we have evidence for; pagination would add interaction
  complexity before need is proven.
- Do not pre-check recommendation defaults by creating answers. That would turn
  agent suggestions into implicit approval and break the gate semantics in
  `shared-semantics.ts`.

## Default selections as recommendations

The Copilot-style checklist pattern is useful when an agent wants to propose
likely choices for the user to confirm. `pi-ask` supports this with
question-level `defaultValues?: string[]`. Defaults are **recommendations**, not
implicit answers.

Schema and validation:

- `defaultValues` must reference that question's business option `value`s.
- `defaultValues` is valid for `single` and `multi`; it is invalid for
  `freeform` and cannot reference the UI-only custom sentinel.
- Single-select questions may contain at most one default value.
- Spark ask facade question params expose `defaultValues` directly on each question.

Runtime semantics:

- `createInitialState()` initializes UI selection state from `defaultValues`,
  but does not create entries in `state.answers` by itself.
- For `multi`, defaults initialize `multiSelectChecked`; when navigating away and
  back, checked state is derived from a committed answer if one exists,
  otherwise from `defaultValues`.
- For `single`, defaults move focus to the default option, but Enter/number
  selection is still required to commit the answer.
- `submit()` continues to derive status from `state.answers` via
  `inferAskSubmitStatus()` / `nextActionForAskSubmit()` in
  `shared-semantics.ts`. Therefore decision/approval gates do not resume until
  the user explicitly commits or submits answers.
- Replay/preserved answers override `defaultValues`; defaults are only for
  questions that have no preserved answer.

Rejected alternatives:

- Option-level `defaultSelected`: convenient for rendering, but spreads a
  question-level policy over options and makes single-select conflicts harder to
  validate.
- Initializing `state.answers` with defaults: too dangerous for
  decision/approval gates because it can turn recommendations into implicit
  approval.
- Treating defaults as `defaultAskChoice()`: current headless/default behavior
  intentionally remains separate from interactive recommendation state.

Regression coverage:

1. Multi-select defaults render checked but do not produce an answer until the
   user accepts/commits.
2. Single-select default focuses the option but does not produce an answer until
   Enter/number selection.
3. Decision/approval required questions with defaults still block on direct
   submit if no explicit answer was committed.
4. Preserved/replay answers override `defaultValues` in both single and multi
   questions.
5. Spark ask facade code passes validated `defaultValues` through without accepting custom
   sentinel labels as default ids.

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
