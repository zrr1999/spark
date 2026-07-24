# AGENTS.md

Spark monorepo: agent-oriented docs for contributors and automation. Product overview lives in [README.md](./README.md).

## Layout

Target package topology follows type-first names:

- `apps/spark-cli` — thin `spark` dispatcher only; it resolves public `spark ...` command groups to Spark app surfaces.
- `apps/spark-tui` — executable native terminal host (`@zendev-lab/spark-tui-app`). Keep host/runtime/editor code here, not in the dispatcher.
- `apps/spark-daemon` — Spark daemon service package that owns local workspace state, IPC, and background execution.
- `apps/spark-cockpit` — Spark Cockpit SvelteKit local web cockpit/projection app. Keep SvelteKit/browser-specific checks isolated from the non-Svelte Spark package checks.
- `packages/spark-*` — Spark-owned capability/runtime packages. Core capability primitives include `spark-core`, `spark-memory`, `spark-web`, `spark-artifacts`, `spark-tasks`, `spark-workflows`, `spark-loop`, and `spark-modes`.
- **Pi SDK kernel (keep)** — `@earendil-works/pi-ai` via `spark-ai`, `@earendil-works/pi-tui` via `spark-tui` / `spark-text`. Model streams, providers, and terminal UI primitives stay on this kernel; do not “de-Pi” by removing these deps.
- **Spark product extension** — `packages/spark-extension` is the single command/tool/policy composition root for native and structurally compatible hosts. The retired `pi-extension` workspace must not be reintroduced. Retained `pi-*` kernel adapter packages must not depend on Spark product/Cockpit packages; only Spark foundation packages are allowed.
- `packages/spark-runtime`, `packages/spark-protocol`, `packages/spark-tui`, and `packages/spark-system` — Spark shared runtime, protocol/schema, reusable TUI boundary, and dependency-light local-system primitives. Cross-surface ask / slash / session-view semantics belong in `spark-protocol`.
- `packages/spark-daemon-client` — protocol-aware local RPC/oRPC client transport shared by TUI, Cockpit, daemon lifecycle helpers, and capabilities. Do not put daemon clients back into `spark-system`.
- `packages/spark-cockpit-*` — Cockpit-private implementation packages (`spark-cockpit-db`, `spark-cockpit-coordination`, `spark-cockpit-i18n`, …); do not put daemon/shared helpers behind Cockpit-private names, and do not hang Cockpit-only catalogs on shared package names.
- `architecture/packages.json` — exhaustive package layer/owner/stability/state-writer inventory. Adding a workspace requires updating this inventory without exceeding its package budget.
- `docs/` — current docs are split into `specs/` and `operations/`; keep `docs/README.md` as the concise map (including the three “runtime” meanings).

## Tooling

- **pnpm** — `packageManager` is pinned in root `package.json`; workspaces live in `pnpm-workspace.yaml` (catalog + overrides align Vite / Vite+ / Vitest versions with [sixbones.dev](https://github.com/zrr1999/sixbones.dev)).
- **Vite+** — Root [`vite.config.ts`](./vite.config.ts) drives `vp fmt`, `vp lint`, and `vp check` (format + lint + type-aware checks). Install the `vp` CLI (see [viteplus.dev](https://viteplus.dev)) for local use; CI installs it via [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp).
- **TypeScript / tests** — `pnpm run check` is the root validation gate: static architecture/distribution/package-boundary/docs/format/lint/type checks, unit/integration suites, and the isolated source-process lifecycle. `pnpm run check:static`, `pnpm run test:unit`, and `pnpm run test:process:source` expose those lanes independently for CI. Use `pnpm run typecheck` for typecheck-only validation. Use `pnpm test` for root Vitest tests except `test/process/`; single-file runs use `pnpm test test/name.test.ts` (without a `--` separator, which Vite+ would forward). Package-specific tests use `pnpm --filter <package> run test`; workspace `check` scripts exist only when the package adds tests or another local invariant beyond the root typecheck.
- **Git hooks** — Managed by [prek](https://github.com/j178/prek) from [`prek.toml`](./prek.toml). After clone, `pnpm install` runs `prepare` → `prek install`; run `prek install-hooks` once if hooks are missing.

## Useful commands

| Command                                  | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `pnpm install`                           | Install dependencies                                             |
| `pnpm run check`                         | Run the root validation gate                                     |
| `pnpm run fix`                           | Format, lint-fix, and typecheck the complete workspace            |
| `pnpm run typecheck`                     | Typecheck root TypeScript, Cockpit, and daemon                    |
| `pnpm run check:test-quality`            | Reject growth or unreviewed drift in source-mirror test debt      |
| `pnpm run test:unit`                     | Run root, package, Cockpit, and daemon unit/integration suites    |
| `pnpm run test:process:source`           | Exercise the exact source dispatcher and daemon lifecycle        |
| `pnpm run test:browser:cockpit`          | Run Cockpit interaction tests in headless Chromium                |
| `pnpm run smoke`                         | Pack, clean-install, and smoke the complete npm product           |
| `pnpm run audit`                         | Audit dependencies for high/critical advisories via npm registry |
| `pnpm run report:hygiene`                | Generate advisory Knip, duplication, and complexity reports       |
| `pnpm test`                              | Root Vitest suite (excluding `test/process/`)                     |
| `pnpm test <path>`                       | Run one root Vitest file                                         |
| `pnpm run test:mutation`                 | Leaf-package mutation CE (10 packages: L0 retry/protocol/cockpit-db/system + L1 channels/cockpit-coordination/session/artifacts/repro/i18n) |
| `node --experimental-strip-types scripts/spark-daemon-readiness.mts` | Emit the Spark daemon readiness audit report |
| `node --experimental-strip-types scripts/spark-zellij-harness.mts` | Run the native TUI/zellij harness |
| `pnpm run build`                         | Build the Spark daemon CLI and Spark Cockpit web app             |
| `pnpm run preview`                       | Start the local Spark Cockpit dev server                         |
| `spark cockpit`                          | Start the built Spark Cockpit production server through the CLI   |
| `pnpm install -g .`                      | Link the unified root `spark` CLI                                |
| `pnpm run publish`                       | Validate, smoke, and publish only `@zendev-lab/spark`             |

## CI

- `.github/workflows/ci-static-checks.yml` — prek + `setup-vp` + prek pass with `vp-check` skipped (avoids duplicating `vp check` already covered by ci-verify).
- `.github/workflows/ci-verify.yml` — parallel static, unit/integration, source-process, npm-product-process, and headless-Chromium Cockpit lanes with one aggregate `verify` result.
- `.github/workflows/ce-mutation.yml` — weekly/manual leaf-package mutation CE (non-blocking).
- `.github/workflows/ci-pr-checks.yml` — PR title validation (zendev).
- `.github/workflows/ci-typos.yml` — spellcheck with `_typos.toml`.

## Extension boundary (Spark-owned; Pi SDK kernel retained)

- First-class surfaces are TUI, Cockpit, and messaging channels on the Spark daemon. `spark-core` exports the host-neutral `SparkHostAPI` contract plus lightweight primitives for Spark extension hosts (not a revival of the retired spark-core capability bag). Structurally compatible loaders may speak the same contract; do not merge it into Cockpit/daemon app code.
- `packages/spark-extension/src/extension/` owns the one Spark product extension implementation. Spark-native hosts load `@zendev-lab/spark-extension`; the root `package.json#pi` list may point at the same source entry for compatibility discovery, but there is no separate Pi product facade package.
- Host-neutral side-thread state and handoff semantics live in `packages/spark-turn`; the Spark-native store, runner, and presentation adapters belong in `apps/spark-tui` and `apps/spark-cockpit` and must not import `pi-coding-agent`.
- Spark extension/shared packages must not import concrete app host internals from `apps/spark-cli`, `apps/spark-tui`, `@zendev-lab/spark-tui-app`, or `@earendil-works/pi-coding-agent` runtime code.
- Shared Spark host/turn code belongs in `packages/spark-host` and `packages/spark-turn`; executable apps keep only bootstrap, UI, daemon, and compatibility-adapter glue. `pi-tui` wrappers stay behind `packages/spark-tui`.
- Prefer Spark-native host tests when changing extension behavior. Contract tests may verify structural compatibility, but do not grow host-specific product APIs.
- Keep builtin extension loading explicit for Spark native hosts; do not reintroduce Pi **product** package discovery or `loadPiSdk` into Spark apps. Direct `@earendil-works/pi-ai` / `pi-tui` use must stay behind the existing Spark package boundaries (`spark-ai` / `spark-tui`+`spark-text`); enforced by `pnpm run check:boundaries` (dependency-cruiser).

## Notes for agents

- Public/default repo-owned tools should use canonical `tool({ action })` surfaces when operations share one domain/state/permission/render/result contract; do not keep fragmented duplicate aliases public, and render action tools as `tool action=<value> ...`.
- Prefer `pnpm run fix` before committing when touching TS/Markdown; pre-commit runs the same command.
- Do not commit secrets or `.env` files.
- **State directories** — Workspace agent runtime lives under `.spark/` (durable memory under `.spark/memory/`, including `learnings/`, `reflections/`, and `recall-candidates.json`). User-level Spark paths use explicit `SPARK_HOME` when set, otherwise the standard XDG config/data/cache/state/runtime roots via `resolveSparkUserPaths()` and `resolveSparkPaths()`. Public role, skill, and workflow definitions remain under `$HOME/.agents/`; project roles, skills, and workflows use `.agents/{roles,skills,workflows}`. Learning / recall / reflection capability code lives in `@zendev-lab/spark-memory` (not separate `spark-learnings` / `spark-recall` packages). Legacy `.learnings/` and `.spark/reflections/` are migrated into `.spark/memory/` when needed.
- Boundary checks should keep retained `pi-*` kernel adapters independent from Spark product/Cockpit packages, keep Spark shared packages independent from the `spark-extension` composition root, and keep both independent from Cockpit/daemon adapter packages.
