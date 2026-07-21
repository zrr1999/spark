# Leaf / L1 continuous evaluation (mutation)

Weekly/manual [Stryker](https://stryker-mutator.io/) runs evaluate whether Vitest unit tests would catch small source mutations. This lane is **continuous evaluation (CE)**, not a merge gate: it reports quality, stays scoped to modules with colocated tests, and never blocks PR verify.

## Scope

### L0 (pure leaves)

| Package | Mutate surface |
| --- | --- |
| `@zendev-lab/spark-retry` | `src/**/*.ts` except tests |
| `@zendev-lab/spark-protocol` | colocated / architecture-covered modules |
| `@zendev-lab/spark-db` | `client.ts`, `dialect.ts`, `migrate.ts` |
| `@zendev-lab/spark-system` | `paths.ts`, `daemon-local-rpc.ts` |

### L1 (Vitest packages with colocated tests)

| Package | Mutate surface |
| --- | --- |
| `@zendev-lab/spark-channels` | modules with `*.test.ts` peers |
| `@zendev-lab/spark-coordination` | modules with `*.test.ts` peers (+ `cockpit-queries.ts`) |
| `@zendev-lab/spark-session` | `action-tool`, `mail-store`, `registry`, `snapshot` |
| `@zendev-lab/spark-artifacts` | `generative-ui` + product store/forge/types/worktree |
| `@zendev-lab/spark-repro` | `src/index.ts` |
| `@zendev-lab/spark-i18n` | `index.ts`, `extension.ts` |

Out of scope: root `test/*.test.ts` (Vitest integration suite; not in mutation CE), Cockpit/daemon full trees, and packages whose behavior is only covered by root integration tests (`spark-host`, `spark-turn`, `spark-ai`, …).

## Commands

```bash
pnpm run test:mutation
pnpm --filter @zendev-lab/spark-channels run test:mutation
```

CI: `.github/workflows/ce-mutation.yml` (Monday 03:17 UTC + `workflow_dispatch`, `continue-on-error`, uploads HTML/JSON reports).

## Timing comparison (local, Apple Silicon / Node 26)

Measured with `ignoreStatic: true`, `StringLiteral` excluded, serial runner (`scripts/run-leaf-mutation.mjs`). Incremental reuse can make later CE runs much faster.

| Lane | What it runs | Typical wall time | Gate? |
| --- | --- | --- | --- |
| Leaf/L1 unit (`vp test run`) | Vitest only | ~0.1–3 s per package | Yes, via package `check` |
| Mutation CE L0 only | 4 packages | **~1.5 min** cold | No |
| Mutation CE L0+L1 | 10 packages | **~15–40 min** cold (channels ~6 min, session ~3 min; coordination is the long pole) | No (weekly, 180 min budget) |
| Root `pnpm test` | `test/**/*.test.ts` (Vitest / `vitest.root.config.ts`) | minutes | Yes, via `pnpm run check` |
| Full `pnpm run check` | boundaries + `vp check` + tests | tens of minutes | Yes (PR/main) |

Prefer the **covered** mutation score when prioritizing test work.

### L1 smoke scores (local cold-ish)

| Package | Wall time | Score (total / covered) |
| --- | --- | --- |
| `spark-repro` | ~3 s | ~36% / ~62% |
| `spark-i18n` | ~5 s | ~53% / ~71% |
| `spark-artifacts` | ~45 s | ~43% / ~67% |
| `spark-session` | ~2.5 min | ~51% / ~64% |
| `spark-channels` | ~6 min | ~49% / ~59% |
| `spark-coordination` | longest L1 (large WS/registration surfaces) | measure in weekly CE |

L0 package split remains in prior CE notes / local `reports/mutation/`.

## Test-runner map

| Surface | Runner today | Mutation CE? |
| --- | --- | --- |
| `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | Vitest (`vp test run`) | Yes, when scoped |
| Root `test/**/*.test.ts` | Vitest via `pnpm test` (`vitest.root.config.ts`; still uses `node:assert/strict`) | No (integration suite; not Stryker-scoped) |

Root suite migration (`node:test` → Vitest runner) is done. Remaining hygiene (optional): unify `assert` → `expect`, and only then consider host/turn mutate surfaces that today rely on root integration coverage.

## Hygiene

- Reports stay local/CI artifacts (`**/reports/mutation/`, `.stryker-tmp/` are gitignored).
- Publish `files` for TypeScript packages exclude `*.test.ts`.
- Prefer behavioral assertions over source-string mirrors.
- Expand mutate lists only after colocated tests catch survivors.
