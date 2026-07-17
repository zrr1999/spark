# AGENTS.md

Spark monorepo: agent-oriented docs for contributors and automation. Product overview lives in [README.md](./README.md).

## Layout

Target package topology follows type-first names:

- `apps/spark-cli` — thin `spark` dispatcher only; it resolves public `spark ...` command groups to Spark app surfaces.
- `apps/spark-tui` — executable native terminal host (`@zendev-lab/spark-tui-app`). Keep host/runtime/editor code here, not in the dispatcher.
- `apps/spark-daemon` — Spark daemon service package that owns local workspace state, IPC, and background execution.
- `apps/spark-cockpit` — Spark Cockpit SvelteKit local web cockpit/projection app. Keep SvelteKit/browser-specific checks isolated from the non-Svelte Spark package checks.
- `packages/spark-*` — Spark-owned capability/runtime packages. Core capability primitives include `spark-extension-api`, `spark-artifacts`, `spark-tasks`, `spark-workflows`, `spark-loop`, and `spark-modes`.
- **Pi SDK kernel (keep)** — `@earendil-works/pi-ai` via `spark-ai`, `@earendil-works/pi-tui` via `spark-tui` / `spark-text`. Model streams, providers, and terminal UI primitives stay on this kernel; do not “de-Pi” by removing these deps.
- **Pi product host (freeze / retire)** — `packages/pi-extension` (legacy facade) and `packages/pi-btw` (loads `pi-coding-agent`). New features target TUI / Cockpit / channels, not the Pi product extension loader. Retained `pi-*` packages must not depend on Spark product/Cockpit packages; only Spark foundation packages and the `@zendev-lab/spark-tui` presentation boundary are allowed.
- `packages/spark-runtime`, `packages/spark-protocol`, `packages/spark-tui`, `packages/spark-db`, and `packages/spark-system` — Spark shared runtime, protocol/schema, reusable TUI boundary, SQLite/migration, and local-system helper packages. Cross-surface ask / slash / session-view semantics belong in `spark-protocol`.
- `packages/spark-cockpit-*` — reserved for Cockpit-private implementation packages; do not put daemon/shared helpers behind Cockpit-private names.
- `docs/` — current docs are split into `specs/` and `operations/`; keep `docs/README.md` as the concise map (including the three “runtime” meanings).

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
| `pnpm run check:daemon-readiness`        | Emit the Spark daemon readiness audit report                     |
| `pnpm run check:zellij-harness`          | Emit the native TUI/zellij harness capability audit report       |
| `pnpm test`                              | Root Node tests only (`test/*.test.ts`)                          |
| `pnpm run test:mutation`                 | Opt-in Stryker pilot for `@zendev-lab/spark-retry`               |
| `pnpm run build`                         | Build the Spark daemon CLI and Spark Cockpit web app             |
| `pnpm run preview`                       | Start the local Spark Cockpit dev server                         |
| `spark cockpit`                          | Start the built Spark Cockpit production server through the CLI   |
| `pnpm install -g .`                      | Link the unified root `spark` CLI                                |
| `pnpm run publish`                       | Validate, build, and publish `apps/*` plus `@zendev-lab/pi-extension` |

## CI

- `.github/workflows/ci-static-checks.yml` — prek + `setup-vp` + full prek pass (matches sixbones pattern).
- `.github/workflows/ci-verify.yml` — `pnpm install` + `pnpm run check`.
- `.github/workflows/ci-pr-checks.yml` — PR title validation (zendev).
- `.github/workflows/ci-typos.yml` — spellcheck with `_typos.toml`.

## Extension boundary (Spark-first; Pi product frozen)

- First-class surfaces are TUI, Cockpit, and messaging channels on the Spark daemon. `spark-extension-api` is the host-neutral TypeScript contract for Spark extension hosts; retained Pi **product** adapters may still speak it until retired. Do not merge this contract into Cockpit/daemon app code.
- `packages/pi-extension/src/extension/` remains loadable by the Pi product as a normal extension until that product path is retired; do not expand its surface for new Spark features.
- Spark extension/shared packages must not import concrete app host internals from `apps/spark-cli`, `apps/spark-tui`, `@zendev-lab/spark-tui-app`, or `@earendil-works/pi-coding-agent` runtime code.
- Shared Spark host/turn code belongs in `packages/spark-host` and `packages/spark-turn`; executable apps keep only bootstrap, UI, daemon, and compatibility-adapter glue. `pi-tui` wrappers stay behind `packages/spark-tui`.
- Prefer Spark-native host tests when changing extension behavior. Keep dual-host contract tests (`test/spark-ext-host-contract.test.ts`, `test/spark-host-runtime-cross.test.ts`) only while the Pi product path remains loadable; do not grow new Pi-product-only APIs.
- Keep builtin extension loading explicit for Spark native hosts; do not reintroduce Pi **product** package discovery or `loadPiSdk` into Spark apps. Direct `@earendil-works/pi-ai` / `pi-tui` use must stay behind the existing Spark package boundaries.

## Notes for agents

- Public/default repo-owned tools should use canonical `tool({ action })` surfaces when operations share one domain/state/permission/render/result contract; do not keep fragmented duplicate aliases public, and render action tools as `tool action=<value> ...`.
- Prefer `vp fmt` / `vp check` before committing when touching TS/Markdown; pre-commit runs `vp check --fix`.
- Do not commit secrets or `.env` files.
- **State directories** — Workspace agent runtime lives under `.spark/`; local learnings under `.learnings/`. Cockpit and daemon app databases live under XDG paths via `resolveSparkPaths()` (`~/.local/share/spark/cockpit`, `~/.local/share/spark/daemon`).
- Boundary checks should keep retained `pi-*` packages independent from Spark product/Cockpit packages except for renamed Spark foundation packages, and keep Spark shared packages independent from Cockpit/daemon adapter packages.
