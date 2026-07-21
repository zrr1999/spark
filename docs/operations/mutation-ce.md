# Leaf-package continuous evaluation (mutation)

Weekly/manual [Stryker](https://stryker-mutator.io/) runs evaluate whether leaf-package unit tests would catch small source mutations. This lane is **continuous evaluation (CE)**, not a merge gate: it reports quality, stays scoped to pure Vitest leaves, and never blocks PR verify.

## Scope

| Package | Mutate surface | Role |
| --- | --- | --- |
| `@zendev-lab/spark-retry` | `src/**/*.ts` except tests | Timing primitives |
| `@zendev-lab/spark-protocol` | colocated / architecture-covered modules only | Protocol schemas / views |
| `@zendev-lab/spark-db` | `client.ts`, `dialect.ts`, `migrate.ts` | SQLite helpers (exclude large snapshot surface until tests catch up) |
| `@zendev-lab/spark-system` | `src/paths.ts`, `src/daemon-local-rpc.ts` | Paths + local RPC |

Out of scope for this CE lane: root `test/*.test.ts` (`node:test`), Cockpit, daemon, `cockpit-snapshot.ts`, and other integration-heavy surfaces.

## Commands

```bash
pnpm run test:mutation
pnpm --filter @zendev-lab/spark-retry run test:mutation
```

CI: `.github/workflows/ci-mutation.yml` (Monday 03:17 UTC + `workflow_dispatch`, `continue-on-error`, uploads HTML/JSON reports).

## Timing comparison (local, Apple Silicon / Node 26)

Measured cold (cleared `reports/mutation` + `.stryker-tmp`), `ignoreStatic: true`, `StringLiteral` excluded, serial runner (`scripts/run-leaf-mutation.mjs`). Incremental reuse can make later CE runs much faster.

### Lane overview

| Lane | What it runs | Typical wall time | Mutants (order) | Gate? |
| --- | --- | --- | --- | --- |
| Leaf unit (`vp test run`, one package) | Vitest only | ~0.1–2 s | — | Yes, via package `check` |
| All four leaf units (serial) | Vitest × 4 | **~6 s** | — | Yes, via package `check` |
| Leaf mutation CE (`pnpm run test:mutation`) | Stryker over 4 leaves | **~1.5 min** cold (~89 s measured) | retry ~44, protocol ~800 scoped, db ~150 scoped, system ~175 scoped | No (`break: null`, weekly CE) |
| Root `pnpm test` | `test/*.test.ts` (`node:test`) | minutes (suite-dependent) | — | Yes, via `pnpm run check` |
| Full `pnpm run check` | Boundaries + `vp check` + root tests + package/cockpit/daemon checks | tens of minutes | — | Yes (PR/main) |

### CE package split (cold serial pass)

| Package | Unit (`vp test run`) | Mutation CE wall | Score (total / covered) |
| --- | --- | --- | --- |
| `spark-retry` | ~1.0 s | ~1–4 s | **100% / 100%** |
| `spark-protocol` | ~1.4 s | ~26 s | **~65% / ~79%** |
| `spark-db` | ~1.2 s | ~9 s | **~63% / ~66%** |
| `spark-system` | ~2.2 s | ~41 s | **~73% / ~83%** |
| **All four** | **~6 s** | **~85–90 s (~1.5 min)** | — |

Read as CE, not CI verify: unit time answers “does behavior still pass?”; mutation time answers “would those tests notice small source edits?” Prefer the **covered** column when prioritizing test work; large historical `NoCoverage` buckets understated quality when untested modules were still mutated.

## Hygiene

- Reports stay local/CI artifacts (`**/reports/mutation/`, `.stryker-tmp/` are gitignored).
- Publish `files` for TypeScript packages exclude `*.test.ts`.
- Prefer behavioral assertions (values / error messages / control flow) over source-string mirrors; mutation CE will not credit the latter.
- Keep CE mutate surfaces aligned with modules that have real colocated tests; expand mutate only after tests catch survivors.
