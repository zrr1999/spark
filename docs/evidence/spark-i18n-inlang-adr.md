# ADR: Inlang/Paraglide strategy for `@zendev-lab/spark-i18n`

Status: accepted for first implementation slice
Date: 2026-06-30
Project: `proj:4c3508b5-6097-48ee-9d52-d2abeec121a8` — Spark Cockpit chat UI and shared i18n package

## Context

The project now needs a shared `@zendev-lab/spark-i18n` package that centralizes localization across:

- `apps/spark-cockpit` SvelteKit UI
- `packages/spark-extension` goal/context/notification copy
- Spark-owned TUI/CLI-facing strings where the full-repo audit marks them user-facing

Current repo observations:

- Cockpit owns `apps/spark-cockpit/src/lib/i18n.ts` plus `apps/spark-cockpit/src/lib/i18n/en.json` and `zh-CN.json`. That module provides locale matching, request dictionary selection, status labels, relative time, enum labels, and byte formatting.
- Cockpit route server files import `getRequestDictionary` / `localeCookieName`; Svelte files import `formatRelativeTime`, `formatByteSize`, `enumLabel`, and `statusLabel` from `$lib/i18n`.
- `packages/spark-extension/src/extension/spark-i18n.ts` owns a separate `SparkLanguage = "en" | "zh"` path and bilingual strings for goal notifications, goal instructions, active context, and related extension copy.
- `apps/spark-tui`, `apps/spark-cli`, `packages/spark-tui`, and some `pi-*` packages have user-facing strings and status labels, but many of those are generic Pi surfaces or machine/debug output. The next audit task must classify them before migration.

The user explicitly chose Inlang: “用inlang吧”. The remaining decision is therefore integration shape, not whether to use Inlang.

## Evidence from official docs

- Paraglide JS is SvelteKit's official i18n integration and is compiler-based, emitting tree-shakable translations with type safety. The SvelteKit setup uses `paraglideVitePlugin({ project, outdir, strategy })`, optional `%lang%`/`%dir%` in `app.html`, server middleware, and `reroute` hooks for localized URL strategies. Source: <https://paraglidejs.com/sveltekit> and <https://svelte.dev/docs/cli/paraglide>.
- Paraglide's Vite docs describe it as build-time i18n for Vite, with generated message functions that tree-shake unused messages. Source: <https://paraglidejs.com/vite>.
- The compiler can run by CLI, bundler plugin, or programmatically. Generated output includes `messages.js`, `runtime.js`, `server.js`, and per-message files. TypeScript support can use `allowJs`; library/package use can emit `.d.ts` with `--emitTsDeclarations`. Source: <https://paraglidejs.com/compiling-messages>.
- Message usage imports generated message functions, e.g. `import { m } from "./paraglide/messages.js"`, supports parameters, `getLocale`/`setLocale`, explicit per-call `{ locale }`, and `LocalizedString`. Source: <https://paraglidejs.com/basics>.
- Standalone Node/server usage compiles messages by CLI or programmatically and can import generated `server.js`, `runtime.js`, and `messages.js` outside SvelteKit. Source: <https://paraglidejs.com/standalone-servers>.
- Paraglide monorepo docs describe two patterns. Pattern 1 compiles each consuming package from a shared `project.inlang` and is recommended when consumers need different runtime strategies. Pattern 2 compiles once in a dedicated i18n package; it works when consumers share a compatible strategy and can import package messages/runtime. Source: <https://paraglidejs.com/monorepo>.
- Inlang project settings live in `project.inlang/settings.json` with required `baseLocale` and `locales`; plugins configure translation file formats and paths. Source: <https://inlang.com/docs/settings> and <https://paraglidejs.com/file-formats>.

## Decision

Use **Inlang/Paraglide JS** as the backing framework for `@zendev-lab/spark-i18n`, but expose a **Spark-owned facade** instead of forcing app/extension code to import generated files directly.

First-phase package strategy:

1. Create `packages/spark-i18n` as the source of truth for Spark localization.
2. Put the Inlang project under the package:
   - `packages/spark-i18n/project.inlang/settings.json`
   - `packages/spark-i18n/messages/en.json`
   - `packages/spark-i18n/messages/zh-CN.json`
3. Compile Paraglide output into the package:
   - `packages/spark-i18n/src/paraglide/`
   - Use CLI/script or Vite-compatible compile path with `--emitTsDeclarations` because the root TypeScript config does not currently enable `allowJs` globally.
4. Export Spark-stable APIs from `packages/spark-i18n/src/index.ts`, for example:
   - `locales`, `defaultLocale`, `type SparkLocale`
   - `type SparkLanguage = "en" | "zh"` if preserving extension semantics requires it
   - `parseAcceptLanguage`, `matchLocale`, `resolveRequestLocale`
   - `getDictionary(locale)` / route-friendly dictionary facades where Cockpit still expects structured page dictionaries
   - formatting helpers: `formatRelativeTime`, `formatByteSize`, `statusLabel`, `enumLabel`
   - message-function namespaces backed by generated Paraglide functions for new migrated strings
5. Keep app-specific policy at the app boundary:
   - Cockpit may keep `localeCookieName = "spark_cockpit_locale"` as a local export or re-export from a thin compatibility facade because cookie names are app policy, not package i18n mechanism.
   - SvelteKit hooks/reroute/localized URLs are **not required in phase 1** because Cockpit currently uses request/cookie/Accept-Language selection, not localized route paths.
   - If localized URLs are later needed, Cockpit can adopt the documented SvelteKit `paraglideMiddleware`/`reroute` path or Pattern 1 per-app compilation without changing the message source location.
6. For non-Svelte consumers (extension/TUI/CLI), prefer explicit locale arguments through Spark facade functions over mutable global locale state. Paraglide supports per-message forced locale (`m.key(args, { locale })`), which avoids request-global assumptions in CLI and agent-host code.

This is closest to Paraglide monorepo Pattern 2 (dedicated package compiles once), with a Spark facade to reduce lock-in and to handle existing structured dictionary consumers.

## Message format policy

- Use Inlang/Paraglide message sources for stable user-visible scalar strings.
- Prefer flat message keys for new messages because Paraglide recommends flat keys, while nested keys are available via bracket notation.
- Existing Cockpit dictionaries contain structured objects and arrays (for example prompt suggestion arrays and status-label maps). Migration should not assume every value can be represented as a single Paraglide scalar message.
- For structured data, use one of these patterns per migration finding:
  1. Convert arrays/records into explicit scalar keys and assemble typed objects in `spark-i18n` facade code.
  2. Keep non-copy structure in TypeScript and fill user-visible copy from generated message functions.
  3. Keep highly dynamic or diagnostic data local/internal unless it is promoted to stable display copy through a Spark facade.
- Do not translate protocol enums, IDs, command kinds, log stream names, or machine-readable status values. Translate display labels derived from those values.

## Consumer integration

### Cockpit

- Short term: replace `$lib/i18n` internals with imports from `@zendev-lab/spark-i18n`, or keep `$lib/i18n.ts` as a thin compatibility facade during migration.
- Preserve current request/cookie behavior in `routes/+layout.server.ts` and server actions.
- Keep current `messages` object shape initially if that minimizes Svelte route churn, but generate/assemble it from `spark-i18n` sources.
- Do not introduce localized URLs or SvelteKit reroute middleware in the first migration unless the implementation discovers it is necessary. This avoids routing churn unrelated to the package extraction.
- If Cockpit later needs SEO/localized paths, use the official SvelteKit integration: `paraglideVitePlugin`, `paraglideMiddleware`, `%lang%`/`%dir%`, and `reroute`.

### Spark extension / goal surfaces

- Move language detection and bilingual goal/context strings behind `@zendev-lab/spark-i18n` where possible.
- Avoid making `spark-i18n` depend on `pi-extension-api` only to reuse `detectCopyLanguage`. Either:
  - move a tiny pure Chinese-character detector into `spark-i18n`, or
  - keep host-specific detection as an adapter input and only centralize messages.
- Preserve `SparkLanguage` semantics if existing project/goal APIs store `"en" | "zh"`; map it to locale values at the facade boundary (`zh` -> `zh-CN`).

### TUI/CLI and generic Pi packages

- Migrate only Spark-owned user-facing copy.
- Keep generic `pi-*` package copy local unless the audit proves it is specifically Spark-facing. `pi-*` packages should not import `spark-*` as a side effect of localization.
- Keep developer diagnostics/log lines local or untranslated unless they are deliberately user-facing UX strings.

## Rejected or not-selected alternatives

| Option | Decision | Reason |
| --- | --- | --- |
| Zero-dependency forever | Rejected as the primary direction | User selected Inlang; zero-dep remains the reversal path via the Spark facade. |
| `typesafe-i18n` | Not selected | Good TypeScript fit, but Inlang/Paraglide has official SvelteKit/Vite integration and generated ESM message functions. |
| `i18next` + ICU | Rejected for first phase | Mature ecosystem but heavier runtime model and broader plugin surface than needed for a local monorepo package. |
| FormatJS / `intl-messageformat` directly | Not selected | Strong ICU formatting foundation, but Paraglide already provides compile-time message functions and can use format plugins. Use direct FormatJS only if advanced ICU formatting becomes the blocker. |
| Fluent | Not selected | Powerful message model but higher migration/tooling cost for current two-locale Spark copy. |
| MessageFormat 2 | Not selected | Promising standard direction but ecosystem adoption is still not the least-risk first migration path. |
| App-local Paraglide only | Rejected for this project | Would improve Cockpit but not centralize extension/TUI/CLI localization in `spark-i18n`. |

## Lock-in and reversal cost

The chosen design intentionally hides generated Paraglide paths behind `@zendev-lab/spark-i18n` exports. If Paraglide becomes a poor fit, the reversal path is:

1. Keep `@zendev-lab/spark-i18n` public exports stable.
2. Replace generated message-function internals with a zero-dep dictionary or another compiler/runtime.
3. Preserve `getDictionary`, locale matching, formatting helpers, and message facade contracts.
4. Update only package internals and tests; consumers should not need bulk import rewrites.

Lock-in risk is therefore mostly in message source format and codegen scripts, not in app/component imports.

## Build/codegen implications

- `packages/spark-i18n` should own a compile/codegen script, likely invoking `paraglide-js compile --project ./project.inlang --outdir ./src/paraglide --emitTsDeclarations`.
- Generated files should be either committed if needed for source-based workspace consumption, or generated before checks/tests. The foundation task must decide based on repo conventions and Node v26 type-stripping behavior.
- Root `tsconfig.base.json` currently does not set `allowJs`; package consumers should not rely on unchecked generated JS. Prefer `--emitTsDeclarations` plus Spark-owned TypeScript wrapper exports.
- Cockpit already has `allowJs: true`, but other Spark packages are compiled by the root TS config and should consume typed facade exports.

## Validation expected in implementation tasks

- `pnpm --filter @zendev-lab/spark-i18n check` (new package)
- package tests for locale matching, forced-locale messages, and key parity
- `pnpm --filter @zendev-lab/spark-cockpit check/test/build`
- affected root/package checks for `spark-extension`, `apps/spark-tui`, `apps/spark-cli`, or root `tsc` depending on migration scope
- grep/boundary evidence that `pi-*` packages did not acquire forbidden `spark-*` imports

## Consequences for the next tasks

- The audit task should classify user-facing strings with the Inlang policy above, especially distinguishing scalar translatable messages from structured dictionary data.
- The package foundation task should create the Inlang project under `packages/spark-i18n` and wrap generated output behind stable exports.
- The Cockpit migration should prefer a compatibility facade first if that keeps route churn small.
- Extension/TUI/CLI migration should use explicit locale arguments and should not depend on SvelteKit middleware or URL routing.
