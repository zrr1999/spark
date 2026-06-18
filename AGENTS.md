# AGENTS.md

Spark monorepo: agent-oriented docs for contributors and automation. Product overview lives in [README.md](./README.md).

## Layout

- `packages/*` — TypeScript libraries wired into Pi and Spark (`spark`, `spark-runtime`, `pi-tasks`, `pi-workflows`, `pi-cue`, …) plus isolated Navia packages (`navia-runner`, `navia-protocol`, `navia-db`, `navia-domain`, `navia-system`, `navia-ui`).
- `apps/navia-web` — Navia SvelteKit local web cockpit/projection app. Keep SvelteKit/browser-specific checks isolated from the non-Svelte Spark package checks.
- `docs/navia/` — Navia product, design, architecture, and release-readiness documentation imported from the standalone Navia repository.

## Tooling

- **pnpm** — `packageManager` is pinned in root `package.json`; workspaces live in `pnpm-workspace.yaml` (catalog + overrides align Vite / Vite+ / Vitest versions with [sixbones.dev](https://github.com/zrr1999/sixbones.dev)).
- **Vite+** — Root [`vite.config.ts`](./vite.config.ts) drives `vp fmt`, `vp lint`, and `vp check` (format + lint + type-aware checks). Install the `vp` CLI (see [viteplus.dev](https://viteplus.dev)) for local use; CI installs it via [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp).
- **TypeScript** — `pnpm run check:tsc` runs `tsc` only; `pnpm run check` runs `vp check`.
- **Tests** — `pnpm test` uses Node’s built-in runner (`node --test`) with `--experimental-strip-types` for the full `test/*.test.ts` suite. Use `pnpm run test:file -- test/name.test.ts` for a targeted file; passing a path to `pnpm test` appends to the full-suite script instead of replacing it.
- **Git hooks** — Managed by [prek](https://github.com/j178/prek) from [`prek.toml`](./prek.toml). After clone, `pnpm install` runs `prepare` → `prek install`; run `prek install-hooks` once if hooks are missing.

## Useful commands

| Command              | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `pnpm install`       | Install dependencies                                             |
| `vp check`           | Format + lint + type check (same path CI expects via pre-commit) |
| `pnpm run verify`    | Spark-only `vp check` then `pnpm test`                           |
| `pnpm run check:tsc` | Spark-only TypeScript check (`tsc --noEmit`); Navia packages are checked by `pnpm run navia:check` |
| `pnpm run navia:check` | Type-check Navia packages and the SvelteKit app from the Spark root |
| `pnpm run navia:test` | Run Navia package/app tests through Vite+ (`vp test run`)        |
| `pnpm run navia:build` | Build Navia runner and web app                                  |
| `pnpm run verify:navia` | `navia:check` then `navia:test` then `navia:build`             |
| `pnpm run verify:merged` | Combined gate: Spark boundaries, Spark tsc, Spark tests, then Navia verify |
| `pnpm run test:file -- test/foo.test.ts` | Run one Node test file without also running the full suite |

## CI

- `.github/workflows/ci-static-checks.yml` — prek + `setup-vp` + full prek pass (matches sixbones pattern).
- `.github/workflows/ci-verify.yml` — `pnpm install` + `pnpm run verify` (type-aware check + Node tests).
- `.github/workflows/ci-pr-checks.yml` — PR title validation (zendev).
- `.github/workflows/ci-typos.yml` — spellcheck with `_typos.toml`.

## Dual-host Spark extension boundary

- `packages/spark/src/extension/` must remain loadable by Pi as a normal extension; do not import `apps/spark` or `@earendil-works/pi-coding-agent` concrete runtime code from shared extension packages.
- Native Spark CLI host code belongs under `apps/spark/src/host/`; pi-tui-specific wrappers belong under `apps/spark/src/tui/`.
- When adding or changing a host-touching extension capability, update the shared `pi-extension-api` contract only if both hosts need it, and add/adjust dual-host tests such as `test/spark-ext-host-contract.test.ts`, `test/spark-host-runtime-cross.test.ts`, and the relevant `spark-cli` host test.
- Keep builtin extension loading explicit for `spark-cli`; do not reintroduce Pi SDK package discovery or `loadPiSdk` into `apps/spark`.

## Notes for agents

- Public/default repo-owned tools should use canonical `tool({ action })` surfaces when operations share one domain/state/permission/render/result contract; do not keep fragmented compatibility aliases public, and render action tools as `tool action=<value> ...`.
- Prefer `vp fmt` / `vp check` before committing when touching TS/Markdown; pre-commit runs `vp check --fix`.
- Do not commit secrets or `.env` files.
- Navia local app/projection state lives under `.navia/`; Spark runtime state remains under `.spark/`; local learnings remain under `.learnings/`. Treat all three as ignored local state unless explicitly exported or documented.
- Boundary checks should keep `pi-*` independent from Spark/Navia packages and keep Spark core/runtime independent from Navia UI/server packages. Navia may depend on approved generic/runtime contracts only after the runtime bridge contract documents that import direction.
