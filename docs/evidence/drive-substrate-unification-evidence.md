# Drive Substrate Unification Evidence

Task: `@drive-substrate-unification`

## Summary

Introduced a shared foreground drive substrate for timer and stale-generation lifecycle across drive discriminators:

- `goal`
- `loop`
- `workflow` (substrate-supported discriminator for future/adjacent workflow drive use)
- `implement` (kept for existing foreground implement continuation compatibility)

This keeps each drive's durable state and tick behavior domain-specific, while unifying the repeated timer cancellation and generation freshness logic used by foreground goal and loop drivers.

## Main code paths

- `packages/spark-extension/src/extension/spark-drive-substrate.ts`
  - New `SparkForegroundDriveSubstrate` class.
  - Centralizes per-drive timer storage, timer clearing, generation bumping, and stale-generation rejection.
  - Adds shared `scheduledDriveDelayMs()` helper for persisted loop schedules.
- `packages/spark-extension/src/extension/spark-command-registration.ts`
  - Replaces separate goal/loop timer and generation maps with the shared substrate.
  - Goal and loop foreground scheduling now call `foregroundDriveSubstrate.schedule()` with `drive: "goal" | "loop"`.
  - Goal and loop clear/await/stale checks now use substrate methods.
  - Existing goal/loop reviewer gates, idle gates, compaction continuation, retry backoff, and UI behavior remain unchanged.
- `test/spark-drive-substrate.test.ts`
  - Covers stale generation cancellation, independent per-drive timer clearing, and schedule delay calculation.

## Inspectable code excerpts

### Shared substrate

From `packages/spark-extension/src/extension/spark-drive-substrate.ts`:

```ts
export type SparkForegroundDriveDiscriminator = "goal" | "loop" | "workflow" | "implement";

export class SparkForegroundDriveSubstrate {
  readonly #timers = new Map<string, ForegroundTimer>();
  readonly #generations = new Map<string, number>();

  schedule(input: SparkForegroundDriveScheduleInput): number {
    const key = this.key(input.drive, input.baseKey);
    const generation = this.nextGeneration(input.drive, input.baseKey);
    this.clearTimer(input.drive, input.baseKey);
    const timer = setTimeout(() => {
      if (this.currentGeneration(input.drive, input.baseKey) !== generation) return;
      this.#timers.delete(key);
      input.run(generation);
    }, input.delayMs);
    timer.unref?.();
    this.#timers.set(key, timer);
    return generation;
  }
}
```

### Goal/loop using the same substrate

From `packages/spark-extension/src/extension/spark-command-registration.ts`:

```ts
const foregroundDriveSubstrate = new SparkForegroundDriveSubstrate();

foregroundDriveSubstrate.schedule({
  drive: "goal",
  baseKey: key,
  delayMs,
  run: (generation) => {
    void runForegroundGoalLoopTick(piApi, ctx, { ...options, generation }).catch(
      (error: unknown) => reportForegroundDriverError(ctx, "goal loop", error),
    );
  },
});

foregroundDriveSubstrate.schedule({
  drive: "loop",
  baseKey: key,
  delayMs,
  run: (generation) => {
    void runForegroundLoopTick(piApi, ctx, { ...options, generation }).catch((error: unknown) =>
      reportForegroundDriverError(ctx, "loop", error),
    );
  },
});
```

Stale-generation checks also use the same substrate:

```ts
foregroundDriveSubstrate.currentGeneration("goal", key) !== options.generation;
foregroundDriveSubstrate.currentGeneration("loop", key) !== options.generation;
```

## Test coverage

- New substrate unit tests:
  - Scheduling a second goal tick invalidates the first goal generation.
  - Clearing goal timer does not clear loop timer for the same session key.
  - Schedule delay helper handles absent, invalid, past, and future timestamps.
- Existing goal/loop/workflow-adjacent tests still pass through `test/spark-tools.test.ts` and `test/spark-widget.test.ts`.

## Validation

Verbatim transcript excerpts are also stored at:

- `docs/evidence/drive-substrate-unification-validation.log`

Commands run from repository root:

```sh
pnpm exec node --experimental-strip-types --test test/spark-drive-substrate.test.ts test/spark-tools.test.ts test/spark-widget.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec vp check --fix
```

Results:

- Focused tests: 211/211 pass.
- TypeScript: pass.
- `vp check --fix`: pass, no warnings, lint errors, or type errors in 501 files.

Validation transcript excerpts:

```text
✔ SparkForegroundDriveSubstrate cancels stale generations per drive
✔ SparkForegroundDriveSubstrate clears timers without affecting other drives
✔ scheduledDriveDelayMs supports absent, invalid, past, and future schedules
...
ℹ tests 211
ℹ pass 211
ℹ fail 0
```

```text
pass: Formatting completed for checked files
pass: Found no warnings, lint errors, or type errors in 501 files
```
