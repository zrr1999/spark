# spark-ask

Rich ask workflows built on top of `pi-ask`.

`spark-ask` provides structured ask workflows for
Spark-specific intent shaping, such as thread
clarification, managed-agent approval, task blocker
resolution, and review-gate decisions.

## Positioning

- `pi-ask` — primitive `ask_user` protocol and minimal UI
  assumptions, including direct custom-input handling for
  structured questions
- `spark-ask` — richer flow metadata,
  replay/elaboration-friendly result shape, confirmed
  output-language selection for thread clarification, and
  Spark artifact integration
