# Spark i18n user-facing string audit

Date: 2026-06-30
Project: `proj:4c3508b5-6097-48ee-9d52-d2abeec121a8` — Spark Cockpit chat UI and shared i18n package
Depends on: `docs/evidence/spark-i18n-inlang-adr.md`

## Scope

The user chose a full-repo user-facing string/i18n audit before implementing `@zendev-lab/spark-i18n`.

This audit covers the requested packages/apps:

- `apps/spark-cockpit`
- `apps/spark-tui`
- `apps/spark-cli`
- `apps/spark-daemon`
- `packages/spark-extension`
- `packages/spark-tui`
- relevant `pi-*` packages touched by Spark UI surfaces, especially `pi-ask`, `pi-loop`, and `pi-cue`

Classification values:

- `migrate-to-spark-i18n`: stable Spark-owned user-facing copy should move behind `@zendev-lab/spark-i18n`.
- `leave-local`: keep in the current package because it is generic Pi UI, app policy, tests, or package-local developer UX.
- `protocol/internal`: not localized; includes machine-readable IDs, protocol enum values, SQL, traces, debug logs, JSON schema constants, and command kinds.
- `non-goal-follow-up`: user-facing but outside this shared-facade milestone because it is a tool/prompt contract, daemon diagnostic, generated data view, or requires a separate locale policy.

## Search evidence

### Current i18n-specific grep

Pattern used:

```text
$lib/i18n|from "[^"]*i18n|from '[^']*i18n|localeCookieName|getRequestDictionary|formatRelativeTime|statusLabel
```

Bounded findings:

- `apps/spark-cockpit/src/lib/i18n.ts` imports local `./i18n/en.json` and `./i18n/zh-CN.json` and exports `locales`, `Locale`, `defaultLocale`, `localeCookieName`, `getDictionary`, `resolveRequestLocale`, `getRequestDictionary`, `parseAcceptLanguage`, `matchLocale`, `formatRelativeTime`, `statusLabel`, `enumLabel`, and `formatByteSize`.
- `apps/spark-cockpit/src/routes/**` and page components import `$lib/i18n` for server request dictionaries and UI formatting.
- `packages/spark-extension/src/extension/spark-i18n.ts` defines `SparkLanguage`, language detection helpers, and bilingual goal/context strings.
- Other `statusLabel` helpers exist in `packages/pi-cue`, `packages/pi-loop`, `packages/spark-extension` UI rendering, and `packages/spark-tui`/TUI code; these need classification rather than blind migration.

### Candidate literal scan

A line-level scanner searched `.ts`, `.svelte`, and `.json` files under the scoped roots, excluding tests, and counted likely human-readable string literals. It intentionally over-counts interpolation-heavy copy and under-counts multi-line template strings.

Top bounded result summary:

| Candidate count | Path | Initial classification |
| ---: | --- | --- |
| 461 | `apps/spark-cockpit/src/lib/i18n/en.json` | `migrate-to-spark-i18n` |
| 247 | `apps/spark-cockpit/src/lib/i18n/zh-CN.json` | `migrate-to-spark-i18n` |
| 175 | `apps/spark-daemon/src/cli.ts` | split: Spark CLI UX -> `migrate`; daemon internals -> `protocol/internal` |
| 156 | `apps/spark-tui/src/native-tui.ts` | completed core UI/help/command strings; data rows/protocol labels remain local/generated |
| 118 | `apps/spark-tui/src/cli/pi-parity-commands.ts` | `non-goal-follow-up` subcommand copy; needs CLI locale policy |
| 109 | `packages/spark-extension/src/extension/spark-workflow-run-tool-registration.ts` | `non-goal-follow-up` tool schema/prompt copy |
| 106 | `packages/spark-extension/src/extension/spark-i18n.ts` | `migrate-to-spark-i18n` |
| 74 | `packages/spark-extension/src/extension/spark-dynamic-workflow-run-rendering.ts` | `non-goal-follow-up` renderer copy |
| 70 | `packages/spark-extension/src/extension/learning-tool-registration.ts` | `non-goal-follow-up` tool schema copy |
| 69 | `packages/spark-extension/src/extension/spark-command-registration.ts` | `non-goal-follow-up` command/phase tool copy |
| 61 | `packages/spark-extension/src/extension/spark-goal-tool-registration.ts` | `non-goal-follow-up` tool schema copy |
| 55 | `packages/spark-extension/src/extension/reviewer-runner.ts` | `protocol/internal` / prompt contract, not UI first |
| 55 | `packages/spark-extension/src/extension/state-housekeeping-rendering.ts` | `non-goal-follow-up` user-readable diagnostics |
| 54 | `apps/spark-cockpit/src/lib/server/workspace-profiles.ts` | split: profile names/descriptions -> `migrate`; file/path errors -> `protocol/internal` |
| 44 | `packages/pi-ask/src/ui/render.ts` | `leave-local` generic Pi UI |
| 44 | `apps/spark-tui/src/cli/daemon.ts` | `migrate-to-spark-i18n` for Spark CLI messages |
| 43 | `packages/spark-extension/src/extension/spark-project-tool-registration.ts` | `non-goal-follow-up` tool schema copy |
| 41 | `packages/spark-extension/src/extension/spark-md-rendering.ts` | `non-goal-follow-up` display renderer copy |
| 35 | `packages/spark-extension/src/extension/spark-init-rendering.ts` | `non-goal-follow-up`: large prompt-like copy |
| 32 | `packages/spark-extension/src/extension/spark-ask-tool.ts` | `non-goal-follow-up` user-visible ask artifacts |
| 31 | `packages/spark-extension/src/extension/spark-status-rendering.ts` | `migrate-to-spark-i18n` after core status strings |
| 30 | `apps/spark-tui/src/cli/resource-manager.ts` | `non-goal-follow-up` Spark CLI install messages |
| 27 | `apps/spark-cli/src/cli.ts` | `migrate-to-spark-i18n` for top-level CLI help/errors |
| 23 | `apps/spark-daemon/src/spark/bridge.ts` | `protocol/internal` logs/events, possible future UX summaries |
| 20 | `apps/spark-tui/src/host/theme.ts` | `leave-local` theme names unless product-localization requires them |
| 19 | `packages/spark-extension/src/extension/spark-ask-tool-registration.ts` | `non-goal-follow-up` tool schema copy |
| 15 | `apps/spark-tui/src/host/model-selector.ts` | completed by shared TUI CLI/model entry strings where used; host internals remain local |
| 12 | `apps/spark-daemon/src/registration.ts` | `migrate-to-spark-i18n` for command-line registration errors |
| 11 | `apps/spark-cockpit/src/lib/workspace-control-display.ts` | `migrate-to-spark-i18n` |
| 10 | `packages/pi-loop/src/goal-format.ts` | `leave-local` generic Pi/Spark loop package unless Spark-specific adapter owns it |

The full scan reported 216 files with candidates. The table above prioritizes files relevant to the planned migration and high-count groups.

## Migration matrix

### `migrate-to-spark-i18n`

| Area | Paths | Rationale | First cut? |
| --- | --- | --- | --- |
| Cockpit dictionaries | `apps/spark-cockpit/src/lib/i18n/en.json`, `zh-CN.json` | Existing localized user-facing product copy; should become Inlang message source / assembled dictionaries. | Yes |
| Cockpit i18n helpers | `apps/spark-cockpit/src/lib/i18n.ts` | Pure locale matching/formatting helpers belong in shared package; app may keep cookie policy facade. | Yes |
| Cockpit display helpers | `apps/spark-cockpit/src/lib/workspace-control-display.ts`, `project-chat-*.ts` default labels | Stable Cockpit UI copy introduced recently; should join shared dictionaries or typed assembly helpers. | Yes, where low churn |
| Cockpit profile labels | `apps/spark-cockpit/src/lib/server/workspace-profiles.ts` names/descriptions such as “Fresh workspace” | User-visible labels/descriptions from server load data. | Yes or immediately after Cockpit facade |
| Extension bilingual core | `packages/spark-extension/src/extension/spark-i18n.ts` | Already explicitly bilingual; belongs in shared package. | Yes |
| Spark status/rendering core | `packages/spark-extension/src/extension/spark-status-rendering.ts`, selected state/goal renderers | User sees these in Spark status/context. | After package foundation; likely same extension migration task |
| Top-level Spark CLI help/errors | `apps/spark-cli/src/cli.ts`, `apps/spark-tui/src/cli.ts`, `apps/spark-tui/src/cli/daemon.ts`, `apps/spark-daemon/src/cli.ts`, `apps/spark-daemon/src/registration.ts` | Human command-line UX. | After Cockpit/core extension; keep output compatibility |

### `non-goal-follow-up`

| Area | Paths | Reason |
| --- | --- | --- |
| Tool registration schemas/descriptions | `packages/spark-extension/src/extension/*-tool-registration.ts`, workflow/learning/project/goal/drive tools | User/agent-facing but semantically tied to tool schemas; localizing them can affect model behavior, so they are outside this UI/shared-facade milestone. |
| Mode/goal/prompt instruction bodies | `packages/spark-extension/src/extension/mode/*`, `spark-mode-prompts.ts`, `spark-workflow-builtins.ts`, `reviewer-runner.ts` | Prompt contracts affect model behavior and reviewer outputs; not simple UI labels. |
| Dynamic workflow/background run rendering | `packages/spark-extension/src/extension/spark-dynamic-workflow-*`, `background-*` | Human-readable dashboards, but data-heavy/generated; needs projection label strategy after core facade. |
| Spark TUI subcommand/resource/daemon helper strings | `apps/spark-tui/src/cli/**`, `apps/spark-daemon/src/**` | Core TUI entry/native help strings were migrated; subcommand diagnostics need a separate CLI locale policy. |
| Daemon bridge/runtime event summaries | `apps/spark-daemon/src/spark/bridge.ts`, invocation/task summary artifacts | Some strings are user-visible artifacts; others are logs/protocol. Needs a narrower daemon diagnostics pass. |

### `leave-local`

| Area | Paths | Reason |
| --- | --- | --- |
| Generic Pi UI packages | `packages/pi-ask/src/**`, `packages/pi-cue/src/**`, `packages/pi-loop/src/**` | These are generic Pi packages. Importing `spark-i18n` would violate package direction and couple Pi packages to Spark. They can keep local labels or later use a Pi-level i18n package, not Spark. |
| Theme names / local dev UX | `apps/spark-tui/src/host/theme.ts`, package-local debug messages | Not part of Spark product localization unless explicitly exposed as product copy. |
| Tests/fixtures | `*.test.ts`, docs examples outside Spark runtime UI | Test copy should stay local unless it is a fixture for i18n itself. |
| App policy constants | `localeCookieName = "spark_cockpit_locale"` | Cookie naming/routing policy belongs to Cockpit; package may expose defaults, but app owns policy. |

### `protocol/internal`

| Area | Examples | Reason |
| --- | --- | --- |
| Protocol constants and command kinds | `task.start.request`, `invocation.cancel.request`, runtime message types | Machine-readable; localization would break protocol. |
| SQL, JSON, file paths, env vars | SQL statements, `SPARK_*`, socket paths, token prefixes | Not user copy. |
| Validation/debug internals | schema enum errors intended for developers, stack/error diagnostics, `JSON.stringify(...)` traces | Prefer stable English developer diagnostics unless intentionally elevated to UI. |
| Log stream/status IDs | `stdout`, `stderr`, `queued`, `acked`, `runtimeInvocationId` | Translate display labels only, never raw IDs. |

## First migration cut

The first cut that can be validated without a flag day should be:

1. Create `packages/spark-i18n` with Inlang project, generated output, Spark facade exports, and tests.
2. Move/assemble Cockpit dictionaries and helpers behind that package while keeping `$lib/i18n.ts` as a thin compatibility facade if necessary.
3. Move `packages/spark-extension/src/extension/spark-i18n.ts` core language helpers and goal/context strings behind `spark-i18n`, preserving `SparkLanguage = "en" | "zh"` as a compatibility type or adapter.
4. Migrate root CLI, native TUI entry, and native TUI core help/command strings; leave tool-registration prompt bodies, daemon diagnostics, generated/dashboard rows, and generic Pi packages as explicit non-goal follow-ups with rationale.

This cut gives immediate value and exercises both major consumer types: SvelteKit Cockpit and Node/extension code.

## Open questions for implementation

- Should generated Paraglide output be committed, or generated before package checks? ADR recommends deciding in package foundation based on workspace source-based package consumption and Node v26 type-stripping behavior.
- How much of Cockpit's current nested dictionary shape should remain as assembled TypeScript objects versus direct Paraglide message functions? The migration should favor compatibility first, then flatten over time.
- Should extension tool schema descriptions be localized at all? They affect model/tool behavior and may be better kept in stable English until there is a deliberate multi-language prompt strategy.
- Should generic Pi packages eventually get their own `pi-i18n` package? They should not import `spark-i18n`.

## Validation expectations for next tasks

- `@spark-i18n-package-foundation`: package tests for locale matching, message availability, and key parity; boundary grep proving no app imports.
- `@spark-i18n-cockpit-migration`: `pnpm --filter @zendev-lab/spark-cockpit check/test/build`, plus grep showing local JSON dictionaries are no longer independent source of truth.
- `@spark-i18n-extension-and-cli-migration`: root/package `tsc` or relevant package checks, plus boundary check proving `pi-*` packages did not acquire Spark imports.
