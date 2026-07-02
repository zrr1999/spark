# Reproduction Project Kind Evidence

Task: `@reproduction-project-kind`

## Summary

Implemented built-in `project.kind = "reproduction"` as the first non-generic project kind:

- Declares `stateSchema` for reproduction-specific JSON state:
  - `target{sourceRefs,targetEnv,expectedOutputs,successMetrics[]}`
  - `experiments[]`
  - `findings[]`
  - `learningRefs[]`
- Declares `phasePlan` mapping:
  - `research -> researcher`
  - `plan -> planner`
  - `implement -> engineer`
- Declares display:
  - badge: `repro`
  - panels: `Target=text`, `Metrics=progress`, `Experiments=counts`, `Findings=list`
- Adds deterministic completion gate:
  - all success metrics must be covered,
  - failed experiments must have disposition,
  - learning must be recorded via `learningRefs[]` or finding-level learning refs.
- Wires project-kind completion gate into `goal({ action: "complete" })` before reviewer execution, so reproduction projects cannot complete while metrics/failed experiment dispositions/learnings are missing.

## Main code paths

- `packages/pi-extension/src/extension/project-kind-registry.ts`
  - Adds built-in reproduction definition.
  - Adds `sparkProjectKindRoleForPhase()`.
  - Adds `evaluateSparkProjectKindCompletionGate()`.
  - Enhances progress rendering so metric arrays count `covered/passed/satisfied` records.
- `packages/pi-extension/src/extension/spark-goal-completion-review.ts`
  - Applies project-kind deterministic completion gate before reviewer completion review.
- `packages/pi-extension/src/extension/spark-goal-tool-registration.ts`
  - Includes deterministic blockers/remainingWork in blocked completion details.

## Test coverage

- `test/spark-project-kind-registry.test.ts`
  - Built-in reproduction kind declares badge, display, phasePlan, and gate string.
  - Reproduction display renders target/metrics/experiments/findings panels.
  - Gate passes when metrics covered, failed experiment disposition exists, and learning is recorded.
  - Gate blocks uncovered metrics, failed experiments without disposition, and missing learning.
- `test/spark-tools.test.ts`
  - Project metadata can set `kind: "reproduction"` and status returns reproduction display panels.
  - `goal({ action: "complete" })` blocks before reviewer when reproduction gate is unsatisfied.

## Validation

Commands run from repository root:

```sh
pnpm exec node --experimental-strip-types --test test/spark-project-kind-registry.test.ts test/spark-tools.test.ts test/spark-widget.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec vp check --fix
```

Results:

- Focused tests: 212/212 pass.
- TypeScript: pass.
- `vp check --fix`: pass, no warnings, lint errors, or type errors in 499 files.
