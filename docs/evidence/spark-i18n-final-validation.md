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
- CLI/TUI entry and native TUI core copy exports in `src/cli.ts`
- extension/goal/context copy exports in `src/extension.ts`
- package tests covering locale matching, Accept-Language parsing, language mapping/detection, generated messages, dictionary assembly, formatting, Cockpit key parity, CLI/TUI entry strings, and extension strings

### Cockpit

- `apps/spark-cockpit/src/lib/i18n/en.json` and `zh-CN.json` were moved into `packages/spark-i18n/src/cockpit/` as ESM-safe TS dictionary modules.
- `apps/spark-cockpit/src/lib/i18n.ts` is now a thin compatibility facade over `@zendev-lab/spark-i18n`.
- Cockpit keeps app-specific `localeCookieName = "spark_cockpit_locale"` locally.

### Spark extension

- `packages/spark-extension/src/extension/spark-i18n.ts` is now a thin re-export facade from `@zendev-lab/spark-i18n/extension`.
- Core language/goal/context strings live in `packages/spark-i18n/src/extension.ts`.
- The shared implementation no longer imports `pi-extension-api`, `pi-tasks`, or `spark-extension` internals.

### Spark CLI/TUI

- `packages/spark-i18n/src/cli.ts` now owns root dispatcher, native TUI entry, and native TUI core help/label/error strings.
- `apps/spark-cli/src/cli.ts` consumes `@zendev-lab/spark-i18n/cli` for `spark --help`, unknown subcommand errors, dispatch failure messages, signal exits, and target labels.
- `apps/spark-tui/src/cli.ts` consumes `@zendev-lab/spark-i18n/cli` for `spark tui --help`, print-prompt validation, daemon attachment display names, `/model` command copy, model-list empty states, JSON event assistant text, and RPC errors.
- `apps/spark-tui/src/native-tui.ts` consumes `@zendev-lab/spark-i18n/cli` for native welcome/help/default responder text, stop/failure/queued-input messages, built-in slash command descriptions, keybinding descriptions, header/footer, folded tool labels, command errors, cockpit open/close messages, and terminal title.
- Runtime smoke fixed the Node v26 ESM workspace path issue by using extensionful internal imports (`./index.ts`, `./cockpit.ts`) and avoiding JSON imports in runtime-loaded package modules.

## Explicit non-goal follow-ups / localization debt

| Surface | Status | Reason |
| --- | --- | --- |
| root `apps/spark-cli/src/cli.ts` dispatcher help/errors | completed core | Now consumes `@zendev-lab/spark-i18n/cli`; non-English locale selection remains a future CLI policy layer. |
| `apps/spark-tui/src/cli.ts` entry help/model/RPC strings | completed core | Now consumes `@zendev-lab/spark-i18n/cli`. |
| `apps/spark-tui/src/native-tui.ts` core UI/help/command strings | completed core | Now consumes `@zendev-lab/spark-i18n/cli`; data-driven cockpit row content and protocol labels remain local/generated data. |
| `apps/spark-tui/src/cli/**` daemon/resource helper strings | out of scope | These are subcommand implementation details and daemon/resource diagnostics; they need a separate CLI locale policy and are not required for this shared facade milestone. |
| `apps/spark-daemon/src/cli.ts` and registration output | out of scope | Mixes user CLI messages and daemon diagnostics; a daemon diagnostics localization pass should be separate. |
| `packages/spark-extension/src/extension/*-tool-registration.ts` descriptions | out of scope | Tool descriptions can affect model/tool behavior, so localize only after a prompt/tool language strategy. |
| reviewer/mode/workflow prompt contracts | out of scope | Behavioral prompt contracts, not simple UI labels. |
| broad dashboard/rendering strings | out of scope | Generated/data-heavy display content should follow after locale plumbing and projection label strategy. |
| `packages/pi-*` strings | leave local | Pi packages must not import Spark packages. A Pi-level i18n package would be separate. |
| protocol constants, IDs, event types, queue statuses | protocol/internal | Must remain stable and machine-readable. |

More detailed matrices:

- `docs/evidence/spark-i18n-user-facing-string-audit.md`
- `docs/evidence/spark-i18n-extension-cli-migration.md`

## Final validation commands

All commands below passed on 2026-06-30:

- `pnpm --filter @zendev-lab/spark-i18n check`
  - Paraglide compilation passed
  - `tsc -p packages/spark-i18n/tsconfig.json --noEmit` passed
  - Vitest passed: 2 files, 14 tests
- `pnpm --filter @zendev-lab/spark-cockpit check`
  - `svelte-check` found 0 errors and 0 warnings
- `pnpm --filter @zendev-lab/spark-cockpit test`
  - 16 files, 71 tests passed
- `pnpm --filter @zendev-lab/spark-cockpit build`
  - production build passed
- `pnpm --filter @zendev-lab/spark-extension check`
  - workspace TypeScript check passed
- `pnpm --filter @zendev-lab/spark-cli check`
  - dispatcher TypeScript check passed
- `pnpm --filter @zendev-lab/spark-tui-app check`
  - native TUI TypeScript check passed
- `spark --help`, `spark tui --help`, and `spark --list-models`
  - runtime smoke passed under Node v26 workspace TS execution
- `pnpm exec tsc -p tsconfig.json --noEmit`
  - root workspace TypeScript check passed
- `node scripts/check-pi-boundaries.mjs`
  - package boundary check passed
- `git diff --check`
  - whitespace/conflict-marker check passed

## Worktree note

`docs/specs/turn.md` was a pre-existing unrelated modified file and is not part of the i18n migration evidence.
