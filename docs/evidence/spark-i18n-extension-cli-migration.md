# Spark i18n extension / CLI migration status

Date: 2026-06-30
Project: `proj:4c3508b5-6097-48ee-9d52-d2abeec121a8`

## Completed in this slice

### Extension core i18n moved behind `spark-i18n`

`packages/spark-extension/src/extension/spark-i18n.ts` is now a thin facade:

```ts
export { ... } from "@zendev-lab/spark-i18n/extension";
```

The implementation now lives in `packages/spark-i18n/src/extension.ts` and includes:

- `SparkLanguage` compatibility exports
- `sparkLanguageForProject`
- `normalizeSparkLanguage`
- goal notification strings
- goal instruction strings
- goal context strings
- active Spark context strings
- system-prompt language directive

Host-package dependencies were removed from the implementation:

- no `@zendev-lab/pi-extension-api` import in `spark-i18n`
- no `@zendev-lab/pi-tasks` import in `spark-i18n`
- no `spark-extension` import in `spark-i18n`

The core language detector is now the pure `detectSparkLanguage` helper from `@zendev-lab/spark-i18n`.

Some core labels use generated Paraglide messages immediately, e.g. `goal_active` and `goal_not_set`, while larger structured goal/context strings are centralized in the package facade for compatibility. Future flattening can move these strings into Paraglide scalar keys without changing `spark-extension` imports.

### CLI/TUI entry i18n moved behind `spark-i18n`

`packages/spark-i18n/src/cli.ts` now centralizes the root dispatcher, native TUI entry strings, and native TUI core UI strings:

- `sparkCliDispatcherStrings()` for `apps/spark-cli/src/cli.ts`
- `sparkTuiCliStrings()` for `apps/spark-tui/src/cli.ts`
- `sparkNativeTuiStrings()` for `apps/spark-tui/src/native-tui.ts`

Migrated consumer surfaces include root `spark --help`, unknown subcommand errors, dispatch failure/signal messages, target labels, `spark tui --help`, `--print` prompt validation, daemon attachment display names, `/model` command description/argument hint, model-list empty states, headless JSON assistant text, RPC parse/unsupported-command errors, native TUI welcome/default help text, stop/failure/restored-input messages, built-in slash command descriptions, keybinding descriptions, command errors, cockpit panel open/close messages, and terminal title.

Runtime smoke also fixed Node v26 direct workspace execution by using extensionful internal imports in `spark-i18n` and replacing runtime JSON imports with TS dictionary modules.

## Explicit non-goal follow-ups / left local

| Surface | Current status | Reason |
| --- | --- | --- |
| `apps/spark-cli/src/cli.ts` dispatcher help/errors | completed core | Consumes `@zendev-lab/spark-i18n/cli`; runtime smoke covers `spark --help`. Locale source/policy for non-English CLI output remains future work. |
| `apps/spark-tui/src/cli.ts` entry/model/RPC strings | completed core | Consumes `@zendev-lab/spark-i18n/cli`; runtime smoke covers `spark tui --help` and `spark --list-models`. |
| `apps/spark-tui/src/native-tui.ts` core UI/help/command strings | completed core | Consumes `@zendev-lab/spark-i18n/cli`; data-driven cockpit rows/protocol values remain local/generated data. |
| `apps/spark-tui/src/cli/**` daemon/resource helper strings | out of scope | Subcommand implementation details and diagnostics need a separate CLI locale policy; not required for this facade milestone. |
| `apps/spark-daemon/src/cli.ts` and `registration.ts` | out of scope | Some strings are user CLI errors; others are daemon diagnostics. Needs a narrower daemon diagnostics pass. |
| `packages/spark-extension/src/extension/*-tool-registration.ts` descriptions | out of scope | Tool schema descriptions affect model/tool behavior. Localize only after deliberate prompt/tool-language strategy. |
| `packages/spark-extension/src/extension/mode/*`, reviewer prompts, workflow builtins | out of scope | Prompt contracts and reviewer JSON constraints are high-risk behavioral strings, not simple UI labels. |
| `packages/spark-extension/src/extension/*rendering.ts` dashboards | out of scope | User-readable but broad/data-heavy; migrate after projection label strategy. |
| generic `packages/pi-*` strings | leave-local | Pi packages must not import `spark-*`. A future Pi-level i18n package would be separate from `spark-i18n`. |
| protocol constants, command kinds, IDs, log streams | protocol/internal | Must remain machine-readable and stable. Translate only display labels. |

## Validation evidence

- `pnpm --filter @zendev-lab/spark-i18n check` passed with Paraglide generation, `tsc`, and 14 tests.
- `pnpm --filter @zendev-lab/spark-extension check` passed.
- `pnpm --filter @zendev-lab/spark-cli check` passed.
- `pnpm --filter @zendev-lab/spark-tui-app check` passed.
- `pnpm exec tsc -p tsconfig.json --noEmit` passed.
- `node scripts/check-pi-boundaries.mjs` passed.
- Runtime smoke passed: `spark --help`, `spark tui --help`, `spark --list-models`.
- Grep evidence: `packages/spark-extension/src/extension/spark-i18n.ts` contains only the facade export from `@zendev-lab/spark-i18n/extension` and no longer contains the duplicated goal copy tables.
- Grep evidence: `apps/spark-cli/src/cli.ts`, `apps/spark-tui/src/cli.ts`, and `apps/spark-tui/src/native-tui.ts` import `@zendev-lab/spark-i18n/cli` for migrated dispatcher, TUI entry, and native TUI core strings.
