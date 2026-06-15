# pi-extension-api

Shared **types-only** TypeScript contract for Pi-style extensions consumed by
both [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
and the spark-cli native pi-tui host.

## Why this package exists

Before this package, every extension package (`@zendev-lab/pi-ask`, `@zendev-lab/pi-cue`,
`@zendev-lab/pi-graft`, `@zendev-lab/pi-roles`, `@zendev-lab/spark`) maintained its own `pi-types.d.ts` shim
that re-declared a slice of `ExtensionAPI` via `declare module
"@earendil-works/pi-coding-agent"`. That meant:

- Five copies of overlapping but slightly drifting types.
- A hard pin on the `@earendil-works/pi-coding-agent` module name even when
  the runtime never imported a value from it.
- No single file to update when the surface changes.

`@zendev-lab/pi-extension-api` collapses those copies into one source of truth. Each
extension package now does:

```ts
import type { ExtensionAPI, ToolConfig } from "@zendev-lab/pi-extension-api";
```

and the same code runs on either host.

## What is exported

The package contains **only TypeScript declarations** — no runtime, no
dependencies. Two hosts implement supersets of these types:

- pi-coding-agent runtime — full Pi semantics (commands, tools, events,
  widgets, sessions). Declares this surface as a subset of its private
  `ExtensionAPI`.
- spark-cli native pi-tui host — `SparkHostRuntime` implements the retained
  surface needed by `@zendev-lab/pi-ask`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-roles`, `@zendev-lab/pi-graft`, and `@zendev-lab/spark`,
  plus host-only helpers for keybindings, message renderers, provider/model
  selection, and the native TUI bridge.

## Contract rules

1. **Every method is optional.** Extensions must guard each call; hosts
   may implement only the slice they care about.
2. **Adding a method is a contract change.** Update both hosts and the
   `test/spark-ext-host-contract.test.ts` contract tests in the same
   change set.
3. **No runtime imports.** This package must remain importable in any
   workspace as a types-only dependency.
4. **Keep slices narrow.** If a feature is only needed by the native Spark CLI
   host, put it behind host-only helpers in `packages/spark-cli/src/host/`
   rather than widening this contract. If an extension package needs it on
   both hosts, add the smallest optional method here and test both hosts.

## Hosts

| Host                                      | Status                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `@earendil-works/pi-coding-agent` runtime | Subset implemented (registerCommand, registerTool, on, sendUserMessage, ui.\*) |
| `@zendev-lab/spark-cli` SparkHostRuntime              | Retained extension surface implemented for native Spark CLI boot               |

## Adding a new capability

1. Decide whether the capability is shared extension contract or host-only
   Spark CLI behavior. Host-only behavior should stay out of this package.
2. Add shared methods/types to `src/index.ts` with `optional` semantics.
3. Update the contract test (`test/spark-ext-host-contract.test.ts`) to
   exercise both hosts via the new shape.
4. Implement on both hosts; only land the change once both pass.
5. If the change touches native Spark CLI boot/loading, also run the relevant
   `@zendev-lab/spark-cli` host tests (extension loader, runtime contract, and bootstrap).
