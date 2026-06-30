# Spark i18n user-facing string audit

Date: 2026-06-30
Project: `proj:4c3508b5-6097-48ee-9d52-d2abeec121a8` — Spark Cockpit chat UI and shared i18n package
Depends on: `docs/evidence/spark-i18n-inlang-adr.md`

## Scope

The user chose a full-repo user-facing string/i18n audit before implementing `@zendev-lab/spark-i18n`, then selected the broad implementation path after reviewer feedback. The implemented scope now covers Cockpit, Spark extension core/tool-copy paths, root CLI, native TUI, TUI daemon/resource/Pi-parity subcommands, and shared daemon CLI diagnostics.

Classification values:

- `migrated-to-spark-i18n`: stable Spark-owned product/CLI/tool copy now flows through `@zendev-lab/spark-i18n`.
- `intentionally-local`: remains local because it belongs to generic Pi packages, app/auth policy, tests, or developer-only diagnostics.
- `protocol/internal`: not localized; includes machine-readable IDs, protocol enum values, SQL, traces, raw logs, JSON schema constants, and command kinds.

## Search evidence

### Initial i18n-specific grep

Pattern used:

```text
$lib/i18n|from "[^"]*i18n|from '[^']*i18n|localeCookieName|getRequestDictionary|formatRelativeTime|statusLabel
```

Findings before migration:

- `apps/spark-cockpit/src/lib/i18n.ts` owned local dictionaries/helpers.
- `packages/spark-extension/src/extension/spark-i18n.ts` owned bilingual goal/context strings.
- CLI/TUI/daemon/tool copy was spread across root CLI, native TUI, TUI subcommands, daemon CLI, and Spark extension tool registration paths.

### Candidate literal scan

A line-level scanner searched `.ts`, `.svelte`, and `.json` files under the scoped roots, excluding tests, and counted likely human-readable string literals. It intentionally over-counts interpolation-heavy copy and under-counts multi-line template strings.

High-priority candidate groups and final status:

| Candidate count | Path | Final classification |
| ---: | --- | --- |
| 461 | `apps/spark-cockpit/src/lib/i18n/en.json` | `migrated-to-spark-i18n` as TS dictionary module |
| 247 | `apps/spark-cockpit/src/lib/i18n/zh-CN.json` | `migrated-to-spark-i18n` as TS dictionary module |
| 175 | `apps/spark-daemon/src/cli.ts` | shared daemon submit/unknown-command diagnostics migrated; auth/token prompt mechanics intentionally local |
| 156 | `apps/spark-tui/src/native-tui.ts` | `migrated-to-spark-i18n` for core UI/help/command strings |
| 118 | `apps/spark-tui/src/cli/pi-parity-commands.ts` | `migrated-to-spark-i18n` for slash descriptions and high-level diagnostics |
| 106 | `packages/spark-extension/src/extension/spark-i18n.ts` | `migrated-to-spark-i18n` via facade |
| 70 | `packages/spark-extension/src/extension/learning-tool-registration.ts` | tool copy flows through `sparkExtensionToolCopy()`; parameter schemas remain local/internal |
| 69 | `packages/spark-extension/src/extension/spark-command-registration.ts` | command/tool copy flows through shared registration facade where registered |
| 61 | `packages/spark-extension/src/extension/spark-goal-tool-registration.ts` | tool copy flows through `sparkExtensionToolCopy()`; behavioral reviewer contracts remain protocol/internal |
| 55 | `packages/spark-extension/src/extension/reviewer-runner.ts` | `protocol/internal` reviewer prompt/JSON contract |
| 54 | `apps/spark-cockpit/src/lib/server/workspace-profiles.ts` | Cockpit dictionary path migrated where applicable; file/path errors local/internal |
| 44 | `packages/pi-ask/src/ui/render.ts` | `intentionally-local` generic Pi UI |
| 44 | `apps/spark-tui/src/cli/daemon.ts` | `migrated-to-spark-i18n` for daemon CLI/client messages |
| 43 | `packages/spark-extension/src/extension/spark-project-tool-registration.ts` | tool copy flows through `sparkExtensionToolCopy()`; parameter schemas remain local/internal |
| 31 | `packages/spark-extension/src/extension/spark-status-rendering.ts` | extension/context/status copy centralized where surfaced through Spark i18n helpers; generated data rows local/internal |
| 30 | `apps/spark-tui/src/cli/resource-manager.ts` | `migrated-to-spark-i18n` for resource command diagnostics |
| 27 | `apps/spark-cli/src/cli.ts` | `migrated-to-spark-i18n` for top-level CLI help/errors |
| 23 | `apps/spark-daemon/src/spark/bridge.ts` | `protocol/internal` runtime bridge logs/events |
| 20 | `apps/spark-tui/src/host/theme.ts` | `intentionally-local` theme catalog data |
| 19 | `packages/spark-extension/src/extension/spark-ask-tool-registration.ts` | tool copy flows through `sparkExtensionToolCopy()`; parameter schema text remains local/internal |
| 15 | `apps/spark-tui/src/host/model-selector.ts` | shared TUI/model entry strings migrated; host internals local/internal |
| 12 | `apps/spark-daemon/src/registration.ts` | auth/registration policy diagnostics intentionally local |
| 10 | `packages/pi-loop/src/goal-format.ts` | `intentionally-local` generic Pi/Spark loop package boundary |

## Migration matrix

### `migrated-to-spark-i18n`

| Area | Paths | Implementation |
| --- | --- | --- |
| Cockpit dictionaries/helpers | `apps/spark-cockpit/src/lib/i18n.ts`, old local JSON dictionaries | App facade imports shared Cockpit dictionaries/helpers from `@zendev-lab/spark-i18n`. |
| Extension language/goal/context copy | `packages/spark-extension/src/extension/spark-i18n.ts` | Extension facade re-exports from `@zendev-lab/spark-i18n/extension`. |
| Extension context provider and tool copy | `packages/spark-extension/src/extension/index.ts`, `spark-tool-operational-notes.ts` | Context label/description, operational notes, and registered tool copy flow through shared extension i18n facade. |
| Top-level Spark CLI | `apps/spark-cli/src/cli.ts` | Uses `sparkCliDispatcherStrings()`. |
| Spark TUI entry/model/RPC | `apps/spark-tui/src/cli.ts` | Uses `sparkTuiCliStrings()`. |
| Native TUI core UI/help | `apps/spark-tui/src/native-tui.ts` | Uses `sparkNativeTuiStrings()`. |
| TUI daemon/resource/Pi-parity subcommands | `apps/spark-tui/src/cli/daemon.ts`, `resource-manager.ts`, `pi-parity-commands.ts` | Use `sparkDaemonCliStrings()`, `sparkTuiResourceStrings()`, and `sparkTuiPiParityStrings()`. |
| Shared daemon CLI diagnostics | `apps/spark-daemon/src/cli.ts` | Uses `sparkDaemonCliStrings()` for shared submit/unknown-command diagnostics. |

### `intentionally-local`

| Area | Paths | Reason |
| --- | --- | --- |
| Generic Pi UI packages | `packages/pi-ask/src/**`, `packages/pi-cue/src/**`, `packages/pi-loop/src/**` | Pi packages must not import Spark packages. A Pi-level i18n package would be separate. |
| Auth/token prompt mechanics | `apps/spark-daemon/src/registration.ts` and selected daemon auth prompts | Kept local to avoid broadening trust/credential behavior while centralizing surrounding daemon command diagnostics. |
| Theme names / catalog data | `apps/spark-tui/src/host/theme.ts` | Package-local catalog data, not shared Spark localization infrastructure. |
| Tests/fixtures | `*.test.ts`, docs examples outside runtime UI | Test assertions/fixtures stay local unless testing i18n itself. |
| App policy constants | `localeCookieName = "spark_cockpit_locale"` | Cookie/routing policy belongs to Cockpit. |

### `protocol/internal`

| Area | Examples | Reason |
| --- | --- | --- |
| Protocol constants and command kinds | `task.start.request`, `invocation.cancel.request`, runtime message types | Machine-readable; localization would break protocol. |
| SQL, JSON, file paths, env vars | SQL statements, `SPARK_*`, socket paths, token prefixes | Not product copy. |
| Reviewer/model prompt contracts | `reviewer-runner.ts`, workflow approval JSON contracts | Behavioral contracts where changing text can affect model output; keep stable unless a deliberate prompt-language strategy is introduced. |
| Raw logs/status IDs | `stdout`, `stderr`, `queued`, `acked`, runtime IDs | Translate display labels only, never raw IDs. |

## Implemented first cut and broadened pass

1. Created `packages/spark-i18n` with Inlang project, generated output, Spark facade exports, and tests.
2. Moved Cockpit dictionaries/helpers behind that package while keeping `$lib/i18n.ts` as a thin compatibility facade.
3. Moved Spark extension language helpers and goal/context strings behind `spark-i18n`.
4. Migrated root CLI, TUI entry, native TUI core help/command strings.
5. Broadened after reviewer feedback to migrate TUI daemon/resource/Pi-parity diagnostics, daemon shared diagnostics, and extension tool/context copy paths through the shared i18n facade.

## Validation expectations satisfied

- `@spark-i18n-package-foundation`: package tests for locale matching, message availability, and key parity passed.
- `@spark-i18n-cockpit-migration`: Cockpit facade/dictionary migration completed and previously validated with check/test/build.
- `@spark-i18n-extension-and-cli-migration`: extension, root TypeScript, TUI, daemon, and root node:test validations passed; package-boundary constraints preserved for generic Pi packages.
