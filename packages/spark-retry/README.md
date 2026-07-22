# spark-retry

`@zendev-lab/spark-retry` provides zero-dependency timing primitives that retry policies can compose:

- `cappedExponentialCeiling(attempt, baseMs, maxMs, options?)` computes a one-based exponential ceiling.
- `scheduledCeiling(attempt, ceilings)` selects a one-based entry and holds the final ceiling for later attempts.
- `equalJitter(ceilingMs, random?)` samples the upper half of a ceiling and clamps the random sample to `[0, 1]`.

The package deliberately does not own retry loops, error classification, logging, cancellation, deadlines, or idempotency. Those policies remain in the domain that knows whether an operation is safe to repeat.

```ts
import { cappedExponentialCeiling, equalJitter } from "@zendev-lab/spark-retry";

const ceiling = cappedExponentialCeiling(attempt, 100, 5_000, { exponentCap: 16 });
const delayMs = equalJitter(ceiling);
```

## Tests

```bash
pnpm --filter @zendev-lab/spark-retry test
pnpm --filter @zendev-lab/spark-retry test:mutation
```

`test:mutation` is part of the leaf-package mutation CE suite (`retry` / `protocol` / `db` / `system`). Run all of them with `pnpm run test:mutation`. It is not part of the default `pnpm run check` gate; CI runs it weekly via `.github/workflows/ce-mutation.yml`. Timing and scoring notes live in [`docs/operations/mutation-ce.md`](../../docs/operations/mutation-ce.md).
