# Test architecture

Spark tests should identify the contract they protect and run at the closest owning boundary.
The root suite is for cross-package behavior; package-local behavior belongs beside the package so
its normal check and mutation evaluation can exercise it.

## Lanes

| Lane | Location | Contract |
| --- | --- | --- |
| Package unit / contract | `packages/*/src/**/*.test.ts` | Pure behavior, schemas, state transitions, adapter contracts |
| App unit / integration | `apps/*/src/**/*.test.ts` | App-owned composition, persistence, process, route, and rendering behavior |
| Root integration | `test/**/*.test.ts` | Behavior that genuinely crosses package or app ownership boundaries |
| Browser component | `pnpm run test:browser:cockpit` | Browser-only interaction and DOM behavior |
| Product smoke | `pnpm run smoke` | Packed, clean-installed public product behavior |
| Mutation CE | `pnpm run test:mutation` | Whether focused package tests detect plausible implementation faults |

Do not move package unit tests into `test/` merely to share setup. Put reusable fixtures or a
contract-suite function at the owning package boundary, then run the same contract against each
implementation.

Keep Node SSR tests for deterministic rendered states and browser tests for behavior that requires
focus, events, layout, or browser APIs. Browser tests run in their own CI job so Chromium setup does
not slow down package unit tests or hide browser-specific failures inside the default suite.

## Assertion hierarchy

Prefer, in order:

1. externally observable return values, state transitions, persisted data, calls at a real boundary,
   exit status, and side effects;
2. versioned schemas or reusable contract suites for producer/consumer and adapter compatibility;
3. AST, type, or dependency rules for architecture constraints;
4. complete golden files for intentionally stable user-visible rendering or protocol text.

Reading production source and asserting that fragments are present is not a behavior test. It is
usually a brittle implementation mirror. `pnpm run check:test-quality` tracks the existing debt and
rejects any count change. After replacing such assertions with behavior, schema/AST checks, or a
reviewed full golden, update and review the lower baseline:

```bash
pnpm run check:test-quality:update
pnpm run check:test-quality
```

The baseline is a ratchet, not an exemption catalog: new files start at zero, and reductions must be
committed so removed debt cannot silently return.

## Golden files

Use a golden only when the representation itself is the contract, such as a complete tool rendering
or agent instruction. Keep one coherent golden per meaningful state instead of many substring
assertions. Dynamic behavior still needs separate tests of the state or input that selects the
golden.

## Review questions

- What real regression becomes invisible if this assertion is deleted?
- Does a synonymous wording or refactor break the test while behavior stays correct?
- Is there at least one negative path for a fail-closed or recovery boundary?
- Does a mock observe an edge, or replace the logic that the test claims to verify?
- Does the test belong to the package that owns the contract?
- Can the failure be replayed in a clean checkout without hidden local state?
