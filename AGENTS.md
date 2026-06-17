# AGENTS.md

Spark monorepo: agent-oriented docs for contributors and automation. Product overview lives in [README.md](./README.md).

## Layout

- `packages/*` — TypeScript libraries wired into Pi (`spark`, `spark-runtime`, `pi-tasks`, `pi-workflows`, `pi-cue`, …).

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
| `pnpm run verify`    | `vp check` then `pnpm test`                                      |
| `pnpm run check:tsc` | Typecheck only (`tsc --noEmit`)                                  |
| `pnpm run test:file -- test/foo.test.ts` | Run one Node test file without also running the full suite |

## CI

- `.github/workflows/ci-static-checks.yml` — prek + `setup-vp` + full prek pass (matches sixbones pattern).
- `.github/workflows/ci-verify.yml` — `pnpm install` + `pnpm run verify` (type-aware check + Node tests).
- `.github/workflows/ci-pr-checks.yml` — PR title validation (zendev).
- `.github/workflows/ci-typos.yml` — spellcheck with `_typos.toml`.

## Dual-host Spark extension boundary

- `packages/spark/src/extension/` must remain loadable by Pi as a normal extension; do not import `packages/spark-cli` or `@earendil-works/pi-coding-agent` concrete runtime code from shared extension packages.
- Native Spark CLI host code belongs under `packages/spark-cli/src/host/`; pi-tui-specific wrappers belong under `packages/spark-cli/src/tui/`.
- When adding or changing a host-touching extension capability, update the shared `pi-extension-api` contract only if both hosts need it, and add/adjust dual-host tests such as `test/spark-ext-host-contract.test.ts`, `test/spark-host-runtime-cross.test.ts`, and the relevant `spark-cli` host test.
- Keep builtin extension loading explicit for `spark-cli`; do not reintroduce Pi SDK package discovery or `loadPiSdk` into `packages/spark-cli`.

## Notes for agents

- Public/default repo-owned tools should use canonical `tool({ action })` surfaces when operations share one domain/state/permission/render/result contract; do not keep fragmented compatibility aliases public, and render action tools as `tool action=<value> ...`.
- Prefer `vp fmt` / `vp check` before committing when touching TS/Markdown; pre-commit runs `vp check --fix`.
- Do not commit secrets or `.env` files.
