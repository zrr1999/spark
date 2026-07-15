# @zendev-lab/spark-ask

Structured human-input primitives for Spark extension hosts. The package is host-neutral and exposes one public action tool:

- `action: "ask"` for structured questions;
- `action: "flow"` when the fullscreen multi-question renderer is required.

## Contract

- Asks wait for an answer, explicit cancellation, or explicit no-selection. Time passing never implies a decision.
- `value` is the stable machine ID; `label` and `description` are user-facing fields.
- Custom input is stored as `customText`. Callers must not add business options named `Other` or `Type your own`.
- Result status is explicit: `answered`, `cancelled`, or `no_selection`.
- Decision and approval gates block on `cancelled` and `no_selection`. Custom text without a required option ID also blocks those gates.
- `summarizeAskResult()`, `summarizeAskAnswers()`, and `createAskArtifactBody()` provide shared human summaries and persistence data.
- Freeform-only flows may submit optional blank answers as `kind: "skipped"`.
- `defaultValues` is valid only for `single` and `multi`, references business option values, and is a recommendation rather than an answer.

Host wrappers own option-description policy and renderer integration. This package owns generic structural validation and ask runtime semantics.
