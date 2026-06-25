# Mode/Drive Family and Control Evidence

Task: `@mode-drive-family-and-control`

## Summary

This change makes Spark's foreground mode a read-only projection of active drive state:

- Derived mode family is now `assist | loop | goal | workflow`.
- `assist` replaces the old `interactive` foreground default in the shared driver axis.
- `/loop` is represented as first-class drive `loop`, not folded into goal.
- Session phase remains the separate lens (`research | plan | implement`) and is still controlled by the `phase` tool.
- No public `mode` setter is registered; the public control surface is the new `drive` tool plus existing drive-specific `goal`, `loop`, and `workflow_run`/`/workflow` entry points.

## Main code paths

- `packages/pi-modes/src/types.ts`
  - `TurnDriver` is now `assist | loop | goal | workflow`.
- `packages/pi-modes/src/resolve.ts`
  - `resolveTurnDriver()` precedence is `workflow > goal > loop > assist`.
- `packages/pi-modes/src/prompt.ts`
  - Prompt marker renders session `Phase: ...` and derived `Mode: ...` only when non-assist.
- `packages/spark-extension/src/extension/spark-drive-state.ts`
  - New normalized drive/mode helpers and active-lens projection helpers.
- `packages/spark-extension/src/extension/spark-drive-tool-registration.ts`
  - New public `drive` tool with `status | start | switch | stop`.
  - `drive=status` returns the read-only derived mode projection.
  - `drive=start|switch` controls `assist | goal | loop` explicitly.
  - Workflow drive is delegated to `workflow_run`/`/workflow`, since it needs a workflow selector/script.
- `packages/spark-extension/src/extension/index.ts`
  - Registers public `drive` and continues exposing `phase`; no public `mode` tool.
- `packages/spark-extension/src/extension/spark-command-registration.ts`
  - Goal ticks stamp drive `goal`; loop ticks stamp drive `loop`.
- `packages/spark-extension/src/extension/spark-status-tool-registration.ts`
  - Status loads goal/loop state and surfaces derived `driveMode`.
- `packages/spark-extension/src/extension/spark-widget-controller.ts`
  - Widget active lens derives drive mode from session goal/loop state.
- `packages/spark-extension/src/ui/spark-widget.ts`
  - Header shows `Phase: <phase>` and appends `Mode: <drive>` for non-assist.

## Test coverage

Updated and added tests cover:

- `resolveTurnDriver()` returns `workflow > goal > loop > assist`.
- Prompt markers use `Phase:` and suppress trivial `research + assist`.
- Phase tool still persists session phase independently.
- Public tool surface includes `drive` and `phase`, and excludes removed public `mode`.
- `drive` tool:
  - reports initial derived `assist` mode,
  - starts loop drive and persists loop state,
  - switches from loop to goal and clears loop state,
  - stops goal and returns to assist,
  - rejects synthetic workflow starts with guidance to use `workflow_run`/`/workflow`.
- Widget renders canonical assist activeLens and preserves phase-only header for assist.

## Validation

While running the final gate, `vp check` also surfaced two small non-drive validation blockers in existing workspace state:

- `packages/spark-ai/src/models-extension.ts` assigned `auth: undefined` under `exactOptionalPropertyTypes`; fixed by omitting `auth` unless the auth column is rendered.
- `packages/spark-ai/tsconfig.json` constrained `rootDir` to `src` even though package checking resolves workspace source imports; removed the no-emit-only rootDir constraint.
- `package.json` had a missing comma between dependencies; restored valid JSON syntax.

Commands run from repository root:

```sh
pnpm exec node --experimental-strip-types --test test/pi-modes.test.ts test/spark-mode-state.test.ts test/spark-tools.test.ts test/spark-widget.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec vp check --fix
```

Results:

- Focused tests: 226/226 pass.
- TypeScript: pass.
- `vp check --fix`: pass, no warnings, lint errors, or type errors in 499 files.
