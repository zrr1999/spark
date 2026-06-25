# Evidence: workflow phase renamed to stage

Task: `@workflow-phase-rename-stage` (`task:689afbe7-be39-46e3-9497-fd00d49ef6e7`)

## Scope clarification

The task constraint "纯重命名，不改 workflow 执行语义" is satisfied by making `stage` the canonical workflow-run internal concept without changing execution behavior. Deprecated aliases are intentionally in scope as compatibility shims for old saved workflows and v1 dynamic-run migration:

- canonical: `stage()`, `meta.stages`, `WorkflowStage*`, `WorkflowRunResult.stages`, `WorkflowRunSnapshot.stages`, `stage_started`, `stage_finished`, `recordStage()`.
- deprecated aliases: `phase()`, `meta.phases`, `WorkflowPhase*`, `.phases`, `.phase`, `phase_started`, `phase_finished`, `onPhase`, `recordPhase()`.
- Spark session phase is separate and unchanged: `research | plan | implement`.

## Grep proof: pi-workflows runtime no longer uses phase for run-internal stage events

Command equivalent:

```text
grep packages/pi-workflows/src/runtime.ts for: workflow phase|phase_started|phase_finished|nodeKind: "phase"|\bphase\(
```

Verbatim tool result:

```text
No matches found
```

Package-wide compatibility grep:

```text
grep packages/pi-workflows/src for: workflow phase|phase_started|phase_finished|nodeKind: "phase"|\bphase\(
```

Verbatim matches are only compatibility event/type aliases:

```text
events.ts-71-       case "stage_started":
events.ts:72:       case "phase_started":
events.ts-95-       case "stage_finished":
events.ts:96:       case "phase_finished":
types.ts-204-   | "stage_started"
types.ts-205-   | "stage_finished"
types.ts:206:   | "phase_started"
types.ts:207:   | "phase_finished"
```

## Focused workflow test output

Command:

```text
node --experimental-strip-types --test test/spark-workflows.test.ts
```

Verbatim status from cue job `J22327`:

```text
✅ done — node --experimental-strip-types --test test/spark-workflows.test.ts
Exit code: 0

✔ pi-workflows records explicit stage statuses (0.468167ms)
✔ pi-workflows emits typed run events and projects snapshots (0.768291ms)
✔ pi-workflows enforces run and stage token budgets between agent calls (0.626084ms)
✔ Spark workflow_run streams live onUpdate events before wait=true completion (26.768625ms)
✔ Spark workflow_run tool executes inline and saved workflow scripts through injected runtime (50.112458ms)
ℹ tests 51
ℹ suites 0
ℹ pass 51
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 663.1445
```

## Combined focused suite output

Command:

```text
node --experimental-strip-types --test test/spark-workflows.test.ts test/pi-workflows-tool.test.ts test/spark-workflow-registry.test.ts test/spark-tools.test.ts test/spark-widget.test.ts
```

Verbatim status from cue job `J22306`:

```text
✅ done — node --experimental-strip-types --test test/spark-workflows.test.ts test/pi-workflows-tool.test.ts test/spark-workflow-registry.test.ts test/spark-tools.test.ts test/spark-widget.test.ts
Exit code: 0

ℹ tests 261
ℹ suites 0
ℹ pass 261
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9333.136042
```

## VP check output

Command:

```text
pnpm exec vp check --fix
```

Verbatim status from cue job `J22346`:

```text
✅ done — pnpm exec vp check --fix
Exit code: 0

pass: Formatting completed for checked files (2.1s)
pass: Found no warnings, lint errors, or type errors in 496 files (1.5s, 10 threads)
```

## TypeScript output

Command:

```text
pnpm exec tsc -p tsconfig.json --noEmit
```

Verbatim status from cue job `J22310`:

```text
✅ done — pnpm exec tsc -p tsconfig.json --noEmit
Exit code: 0
```

## Main implementation paths

- `packages/pi-workflows/src/types.ts`
- `packages/pi-workflows/src/metadata.ts`
- `packages/pi-workflows/src/runtime.ts`
- `packages/pi-workflows/src/events.ts`
- `packages/pi-workflows/src/builtins.ts`
- `packages/spark-extension/src/extension/spark-workflow-run-tool-registration.ts`
- `packages/spark-extension/src/extension/spark-dynamic-workflow-event-store.ts`
- `packages/spark-runtime/src/workflow-role-run-adapter.ts`
- `README.md`
- `docs/dynamic-workflow-benchmark.md`
- `docs/live-dynamic-workflow-refactor.md`
- `docs/live-dynamic-workflow-parity-evidence.md`
