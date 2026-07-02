# Spark i18n extension / CLI migration status

Date: 2026-06-30
Project: `proj:4c3508b5-6097-48ee-9d52-d2abeec121a8`

## Completed migration

### Extension core and tool copy

`packages/pi-extension/src/extension/spark-i18n.ts` remains a thin facade over `@zendev-lab/spark-i18n/extension`.

`packages/spark-i18n/src/extension.ts` now centralizes:

- Spark language detection and normalization helpers
- goal notifications, goal instructions, and goal context strings
- active Spark context strings
- system-prompt language directive
- Spark context provider label/description
- Spark tool operational notes appended to registered tool descriptions
- Spark tool label/description/prompt-guideline copy via `sparkExtensionToolCopy()` at the registration boundary

All public and internal Spark extension tool registrations now flow through `sparkExtensionToolCopy()` before registration. This keeps tool/prompt copy behind a Spark-owned i18n facade without coupling generic `pi-*` packages to `spark-*` packages.

Host-package dependencies remain excluded from the shared implementation:

- no `@zendev-lab/pi-extension-api` import in `spark-i18n`
- no `@zendev-lab/pi-tasks` import in `spark-i18n`
- no `spark-extension` import in `spark-i18n`

### CLI/TUI and daemon diagnostics

`packages/spark-i18n/src/cli.ts` now centralizes:

- root dispatcher strings via `sparkCliDispatcherStrings()`
- Spark TUI entry/model/RPC strings via `sparkTuiCliStrings()`
- native TUI core UI/help/command strings via `sparkNativeTuiStrings()`
- TUI resource install/list/update/remove diagnostics via `sparkTuiResourceStrings()`
- Pi-parity slash-command descriptions and high-level diagnostics via `sparkTuiPiParityStrings()`
- daemon client/help/native command diagnostics via `sparkDaemonCliStrings()`

Migrated consumer surfaces include:

- `apps/spark-cli/src/cli.ts`
- `apps/spark-tui/src/cli.ts`
- `apps/spark-tui/src/native-tui.ts`
- `apps/spark-tui/src/cli/daemon.ts`
- `apps/spark-tui/src/cli/resource-manager.ts`
- `apps/spark-tui/src/cli/pi-parity-commands.ts`
- `apps/spark-daemon/src/cli.ts` for shared daemon submit/unknown-command diagnostics
- `packages/pi-extension/src/extension/index.ts`
- `packages/pi-extension/src/extension/spark-tool-operational-notes.ts`

Runtime smoke also fixed Node v26 direct workspace execution by using extensionful internal imports in `spark-i18n` and replacing runtime JSON imports with TS dictionary modules.

## Intentionally local / not translated

| Surface | Status | Reason |
| --- | --- | --- |
| generic `packages/pi-*` UI strings | intentionally local | Pi packages must not import Spark packages; a future Pi-level i18n package would be separate. |
| protocol constants, command kinds, event IDs, raw queue/status IDs | protocol/internal | Must remain machine-readable and stable; only display labels are localized. |
| raw logs, stack traces, generated JSON, SQL, file paths, env vars | protocol/internal/developer diagnostics | Not product localization copy. |
| daemon registration secrets/token prompts | local policy boundary | Auth/token handling remains in daemon/host policy; user-facing daemon command diagnostics now have shared facade coverage. |

## Validation evidence

Passing validation commands for this broadened slice:

- `pnpm --filter @zendev-lab/spark-i18n check`
- `pnpm --filter @zendev-lab/pi-extension check`
- `pnpm --filter @zendev-lab/spark-tui-app check`
- `pnpm --filter @zendev-lab/spark-daemon check`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- focused root node:test coverage for touched ask/goal paths:
  - `node --experimental-strip-types --test --test-name-pattern "goal start enables same-turn reviewer auto-answer" test/spark-tools.test.ts`
  - `node --experimental-strip-types --test --test-name-pattern /goal foreground loop records unmet reviewer verdict before continuation test/spark-tools.test.ts`
- focused daemon package test: `pnpm --filter @zendev-lab/spark-daemon test -- spark-daemon-cli`

Grep evidence:

- `packages/pi-extension/src/extension/spark-tool-operational-notes.ts` re-exports from `@zendev-lab/spark-i18n/extension`.
- `packages/pi-extension/src/extension/index.ts` imports `sparkExtensionToolCopy` and `sparkExtensionContextProviderStrings` from `@zendev-lab/spark-i18n/extension`.
- `apps/spark-cli/src/cli.ts`, `apps/spark-tui/src/cli.ts`, `apps/spark-tui/src/native-tui.ts`, `apps/spark-tui/src/cli/daemon.ts`, `apps/spark-tui/src/cli/resource-manager.ts`, and `apps/spark-tui/src/cli/pi-parity-commands.ts` import `@zendev-lab/spark-i18n/cli`.
