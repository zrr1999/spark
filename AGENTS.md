# AGENTS.md

Spark monorepo: agent-oriented docs for contributors and automation. Product overview lives in [README.md](./README.md).

## Layout

Target package topology follows type-first names:

- `apps/spark-cli` — thin `spark` dispatcher only; it resolves public `spark ...` command groups to Spark app surfaces.
- `apps/spark-tui` — executable native terminal host (`@zendev-lab/spark-tui-app`). Keep host/runtime/editor code here, not in the dispatcher.
- `apps/spark-daemon` — Spark daemon service package that owns local workspace state, IPC, and background execution.
- `apps/spark-cockpit` — Spark Cockpit SvelteKit local web cockpit/projection app. Keep SvelteKit/browser-specific checks isolated from the non-Svelte Spark package checks.
- `packages/pi-*` — host-neutral Pi-style capabilities and contracts (`pi-extension-api`, `pi-tasks`, `pi-workflows`, `pi-cue`, …). These must not depend on Spark product packages.
- `packages/spark-extension` — Spark Pi-style extension facade. It owns Spark command/tool policy and depends on `pi-extension-api` instead of concrete host runtimes.
- `packages/spark-runtime`, `packages/spark-protocol`, `packages/spark-tui`, `packages/spark-db`, and `packages/spark-system` — Spark shared runtime, protocol/schema, reusable TUI boundary, SQLite/migration, and local-system helper packages.
- `packages/spark-cockpit-*` — reserved for Cockpit-private implementation packages; do not put daemon/shared helpers behind Cockpit-private names.
- `docs/navia/` — Historical cockpit product, design, architecture, and release-readiness documentation imported from the standalone Navia repository.

## Tooling

- **pnpm** — `packageManager` is pinned in root `package.json`; workspaces live in `pnpm-workspace.yaml` (catalog + overrides align Vite / Vite+ / Vitest versions with [sixbones.dev](https://github.com/zrr1999/sixbones.dev)).
- **Vite+** — Root [`vite.config.ts`](./vite.config.ts) drives `vp fmt`, `vp lint`, and `vp check` (format + lint + type-aware checks). Install the `vp` CLI (see [viteplus.dev](https://viteplus.dev)) for local use; CI installs it via [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp).
- **TypeScript / tests** — `pnpm run check` is the root validation gate: SvelteKit sync, Pi package boundary guard, `vp check`, root Node tests, workspace package checks, Spark Cockpit tests, and Spark daemon tests. Use `pnpm run check:tsc` for typecheck-only validation. Use `pnpm test` for root Node tests only; single-file runs use `pnpm exec node --experimental-strip-types --test test/name.test.ts`. Package-specific tests use `pnpm --filter <package> run test`.
- **Git hooks** — Managed by [prek](https://github.com/j178/prek) from [`prek.toml`](./prek.toml). After clone, `pnpm install` runs `prepare` → `prek install`; run `prek install-hooks` once if hooks are missing.

## Useful commands

| Command                                  | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `pnpm install`                           | Install dependencies                                             |
| `pnpm run check`                         | Run the root validation gate                                     |
| `vp check`                               | Format + lint + type check (same path CI expects via pre-commit) |
| `pnpm run check:tsc`                     | Typecheck only (`tsc --noEmit`)                                  |
| `pnpm test`                              | Root Node tests only (`test/*.test.ts`)                          |
| `pnpm run build`                         | Build the Spark daemon CLI and Spark Cockpit web app             |
| `pnpm run preview`                       | Start the local Spark Cockpit dev server                         |
| `pnpm install -g .`                      | Link the unified root `spark` CLI                                |
| `pnpm run publish`                       | Validate, build, and publish `apps/*` plus `@zendev-lab/spark-extension` |

## CI

- `.github/workflows/ci-static-checks.yml` — prek + `setup-vp` + full prek pass (matches sixbones pattern).
- `.github/workflows/ci-verify.yml` — `pnpm install` + `pnpm run check`.
- `.github/workflows/ci-pr-checks.yml` — PR title validation (zendev).
- `.github/workflows/ci-typos.yml` — spellcheck with `_typos.toml`.

## Dual-host Spark extension boundary

- `pi-extension-api` is the host-neutral TypeScript contract for Pi-style extensions. Do not merge it into Spark product code; Spark extension packages depend on this contract instead.
- `packages/spark-extension/src/extension/` is the Spark extension facade path. It must remain loadable by Pi as a normal extension.
- Spark extension/shared packages must not import concrete app host internals from `apps/spark-cli`, `apps/spark-tui`, `@zendev-lab/spark-tui-app`, or `@earendil-works/pi-coding-agent` runtime code.
- Native Spark host code belongs in executable app packages (`apps/spark-tui` for the terminal host); pi-tui-specific wrappers should stay behind the reusable `packages/spark-tui` boundary.
- When adding or changing a host-touching extension capability, update `pi-extension-api` only if both hosts need the contract, and add/adjust dual-host tests such as `test/spark-ext-host-contract.test.ts`, `test/spark-host-runtime-cross.test.ts`, and the relevant Spark host test.
- Keep builtin extension loading explicit for Spark native hosts; do not reintroduce Pi SDK package discovery or `loadPiSdk` into Spark apps.

## Notes for agents

- Public/default repo-owned tools should use canonical `tool({ action })` surfaces when operations share one domain/state/permission/render/result contract; do not keep fragmented duplicate aliases public, and render action tools as `tool action=<value> ...`.
- Prefer `vp fmt` / `vp check` before committing when touching TS/Markdown; pre-commit runs `vp check --fix`.
- Do not commit secrets or `.env` files.
- Spark Cockpit local app/projection state currently lives under `.navia/`; Spark runtime state remains under `.spark/`; local learnings remain under `.learnings/`. Treat all three as ignored local state unless explicitly exported or documented.
- Boundary checks should keep `pi-*` independent from Spark/Cockpit packages, keep Spark shared packages independent from Cockpit/daemon adapter packages, and treat legacy `navia-*` names in active docs as historical/migration-only context.
