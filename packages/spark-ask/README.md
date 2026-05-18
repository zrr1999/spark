# spark-ask

Lightweight Spark ask presets built on top of `pi-ask`.

`spark-ask` provides Spark-specific question presets and
copy for intent shaping, managed-agent approval, task
blocker resolution, and review-gate decisions. Generic
ask protocol, state, renderer, replay, settings, and
payload storage live in `pi-ask`.

## Positioning

- `pi-ask` — reusable ask protocol, flow state machine,
  renderer, replay helpers, settings, and direct
  custom-input handling
- `spark-ask` — Spark preset flows, Spark copy, and type
  aliases over the generic `pi-ask` flow API
- `spark` — Pi extension tools that persist Spark ask
  answers as artifacts
