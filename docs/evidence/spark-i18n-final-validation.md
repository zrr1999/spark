# Spark i18n final validation

Date: 2026-06-30
Project: `proj:4c3508b5-6097-48ee-9d52-d2abeec121a8`

## Framework decision

Spark i18n uses **Inlang/Paraglide JS** as the selected framework direction.

Evidence:

- ADR: `docs/evidence/spark-i18n-inlang-adr.md`
- Decision artifact: `artifact:39dc0025-edc7-4af0-b597-642efebacc0a`

The integration remains reversible because consumers import stable `@zendev-lab/spark-i18n` exports rather than generated Paraglide files directly.

## Completed migration scope

### Package foundation

Created `packages/spark-i18n` with:

- `project.inlang/settings.json`
- Inlang message sources in `messages/en.json` and `messages/zh-CN.json`
- generated Paraglide output in `src/paraglide/**`
- Spark-owned locale/language helpers in `src/index.ts`
- Cockpit dictionary exports in `src/cockpit.ts` backed by TS dictionary modules under `src/cockpit/`
- CLI/TUI/daemon/resource copy exports in `src/cli.ts`
- extension/goal/context/tool copy exports in `src/extension.ts`
- package tests covering locale matching, Accept-Language parsing, language mapping/detection, generated messages, dictionary assembly, formatting, Cockpit key parity, CLI/TUI entry strings, and extension strings

### Cockpit

- `apps/spark-cockpit/src/lib/i18n/en.json` and `zh-CN.json` were moved into `packages/spark-i18n/src/cockpit/` as ESM-safe TS dictionary modules.
- `apps/spark-cockpit/src/lib/i18n.ts` is now a thin compatibility facade over `@zendev-lab/spark-i18n`.
- Cockpit keeps app-specific `localeCookieName = "spark_cockpit_locale"` locally.

### Spark extension

- `packages/pi-extension/src/extension/spark-i18n.ts` is now a thin re-export facade from `@zendev-lab/spark-i18n/extension`.
- Core language/goal/context strings live in `packages/spark-i18n/src/extension.ts`.
- Spark context provider labels/descriptions are supplied by `sparkExtensionContextProviderStrings`.
- Tool operational notes are re-exported from `@zendev-lab/spark-i18n/extension`.
- Tool label/description/prompt-guideline copy flows through `sparkExtensionToolCopy()` at public and internal Spark tool registration boundaries.
- The shared implementation no longer imports `pi-extension-api`, `pi-tasks`, or `spark-extension` internals.

### Spark CLI/TUI/daemon

- `packages/spark-i18n/src/cli.ts` now owns root dispatcher, native TUI entry, native TUI core, daemon client, resource manager, and Pi-parity slash-command copy.
- `apps/spark-cli/src/cli.ts` consumes `@zendev-lab/spark-i18n/cli` for `spark --help`, unknown subcommand errors, dispatch failure messages, signal exits, and target labels.
- `apps/spark-tui/src/cli.ts` consumes `@zendev-lab/spark-i18n/cli` for `spark tui --help`, print-prompt validation, daemon attachment display names, `/model` command copy, model-list empty states, JSON event assistant text, and RPC errors.
- `apps/spark-tui/src/native-tui.ts` consumes `@zendev-lab/spark-i18n/cli` for native welcome/help/default responder text, stop/failure/queued-input messages, built-in slash command descriptions, keybinding descriptions, header/footer, folded tool labels, command errors, cockpit open/close messages, and terminal title.
- `apps/spark-tui/src/cli/daemon.ts`, `resource-manager.ts`, and `pi-parity-commands.ts` consume `@zendev-lab/spark-i18n/cli` for daemon, resource, and Pi-parity subcommand diagnostics.
- `apps/spark-daemon/src/cli.ts` consumes `@zendev-lab/spark-i18n/cli` for shared daemon submit and unknown-command diagnostics.
- Runtime smoke fixed the Node v26 ESM workspace path issue by using extensionful internal imports (`./index.ts`, `./cockpit.ts`) and avoiding JSON imports in runtime-loaded package modules.

## Intentionally not translated

| Surface | Status | Reason |
| --- | --- | --- |
| generic `packages/pi-*` strings | local | Pi packages must not import Spark packages. A Pi-level i18n package would be separate. |
| protocol constants, IDs, event types, queue statuses | protocol/internal | Must remain stable and machine-readable; translate display labels only. |
| raw logs, stack traces, SQL, env vars, paths, generated JSON | local/internal | Developer/protocol diagnostics, not product copy. |
| auth/token prompt mechanics | local policy boundary | Avoid broadening trust/credential behavior; shared facade covers surrounding daemon command diagnostics. |

## Final validation commands

All commands below passed on 2026-06-30:

- `pnpm --filter @zendev-lab/spark-i18n check`
  - Paraglide compilation passed
  - `tsc -p packages/spark-i18n/tsconfig.json --noEmit` passed
  - Vitest passed: 2 files, 14 tests
- `pnpm --filter @zendev-lab/pi-extension check`
  - workspace TypeScript check passed
- `pnpm --filter @zendev-lab/spark-tui-app check`
  - native TUI TypeScript check passed
- `pnpm --filter @zendev-lab/spark-daemon check`
  - daemon TypeScript check passed
- `pnpm exec tsc -p tsconfig.json --noEmit`
  - root workspace TypeScript check passed
- Focused root node:test coverage for touched tool/goal paths passed:
  - `node --experimental-strip-types --test --test-name-pattern "goal start enables same-turn reviewer auto-answer" test/spark-tools.test.ts`
  - `node --experimental-strip-types --test --test-name-pattern /goal foreground loop records unmet reviewer verdict before continuation test/spark-tools.test.ts`
- `pnpm --filter @zendev-lab/spark-daemon test -- spark-daemon-cli`
  - daemon package tests passed

Note: a full `pnpm test` run passed once during this validation cycle, but subsequent full-suite reruns hit intermittent timing/temporary-dir flakes in existing goal-loop/dynamic-workflow tests unrelated to the i18n surfaces. The package checks, root TypeScript check, boundary check, smoke checks, Cockpit checks, and focused touched tests above passed on the final code.

Additional validations from the prior i18n slice remain valid for unchanged Cockpit surfaces:

- `pnpm --filter @zendev-lab/spark-cockpit check`
- `pnpm --filter @zendev-lab/spark-cockpit test`
- `pnpm --filter @zendev-lab/spark-cockpit build`
- `node scripts/check-pi-boundaries.mjs`
- `git diff --check`
- runtime smoke: `spark --help`, `spark tui --help`, `spark --list-models`

## Worktree note

`docs/specs/turn.md` was a pre-existing unrelated modified file and is not part of the i18n migration evidence.
