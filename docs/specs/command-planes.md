# Spark command planes

Canonical CLI grammar:

```text
spark <plane> <resource> <verb> [args...]
```

## Namespaces

| Namespace | Role | Owns | Does not own |
| --- | --- | --- | --- |
| `spark daemon` | daemon execution plane | persistent sessions, channel listeners, SQLite invocations, autonomous driver timing/retry/recovery, events, logs, process state | domain goal/review/task definitions |
| `spark cockpit` | coordination plane and web UI host | project, task, goal, review, evidence, workflow, workspace coordination, assign, and Cockpit UI | daemon execution or autonomous timers, local process logs, TUI rendering |
| `spark tui` | tui local control plane | interactive terminal UI, attach/resume, visible transcript, theme, export | canonical business-state ownership |
| slash `system` | TUI kernel command source | `/help`, `/exit`, `/quit`, `/clear`, `/reload` | project/task/goal/session/workflow commands |
| slash `extension` | extension command source | extension-owned resource commands | TUI kernel lifecycle |

`spark cockpit` is both the coordination CLI and the web UI host; it is not a second daemon execution plane.

## Boundary invariants

- Every stateful domain has exactly one authoritative owner. `packages/spark-cockpit-coordination` owns server coordination plus Cockpit query/projection APIs, but its projections are never execution truth for tasks, runs, artifacts, asks, reviews, or invocations.
- Transports and app adapters translate through owner APIs; they do not duplicate execution or policy, and they must not read or write another owner's store. Cockpit may cache or project Spark state, but it must not mutate local Spark stores directly.
- Reusable capability and runtime behavior belongs in `packages/spark-*`; executable apps retain bootstrap, presentation, and compatibility glue. Boundary regressions are enforced by the dependency-cruiser stage of `pnpm run check`.

### Capability owners

| Domain | Authoritative owner | Adapters and projections |
| --- | --- | --- |
| persistent sessions, invocations, Side Threads, channel execution | `apps/spark-daemon` using the shared registry/store contracts | local RPC, runtime WebSocket, TUI, Cockpit, channel transports |
| autonomous goal/loop/repro/implement/workflow cadence, retry, and recovery | `apps/spark-daemon`; capability packages provide registered success/retry policy | TUI, Cockpit, and compatible hosts send controls and render `driver.update` |
| model/tool turn execution and effect policy | `spark-turn` and `spark-host` | daemon and native host runners provide session context |
| cross-surface schemas and semantics | `spark-protocol` | each transport performs validation and translation only |
| projects, tasks, goals, reviews, workflows, and evidence coordination | `spark-cockpit-coordination` and the capability package named for the domain | Cockpit routes and UI are replaceable projections |
| terminal presentation and interaction | `apps/spark-tui` behind `spark-tui` / `spark-text` boundaries | no durable business-state ownership |
| extension composition | `spark-extension` | compatible loaders may call the same host-neutral contract; no second facade owns behavior |

Generated UI is artifact-backed data, never executable MDX, JS, JSX, imports, exports, or raw HTML. Public action-tool names remain canonical. Serialized `.spark/` markers change only through an explicit, idempotent migration with compatibility tests.

## Architecture growth policy

The default place for a change is inside its existing owner. Create another workspace package only when it establishes a stable dependency direction used by more than one surface, has a narrow public contract, and can be tested without importing a concrete app. Splitting a large implementation into private modules inside its owner is preferred when no new dependency boundary exists. A package must not be created merely to shorten a file or to mirror a product screen.

Before adding a second adapter or surface, first move shared validation and semantics into the existing protocol/owner API. Transports remain thin, projections must be rebuildable, and caches cannot become admission or execution truth. Compatibility adapters have written exit criteria and do not receive new product behavior.

`pnpm run check:architecture` is the mechanical growth ratchet. During the early product phase its ceilings are recorded in `architecture/packages.json` plus a 4,000-line production-file limit, and it rejects additions to the frozen compatibility extension manifest. The headroom allows a small number of evidence-backed owner boundaries without pinning every ceiling to today's count. These remain ceilings, not design targets: an oversized module should still be split at a domain/adapter boundary before it reaches the limit. Raising a ceiling requires an architecture rationale in the same change; deleting a package or compatibility manifest entry never requires lowering a frozen allowlist first.

### Open-source adoption

Adopt a library only when it removes a maintained Spark mechanism or supplies a well-bounded primitive; adding a second implementation alongside the old one does not count as reuse. A proposal must show:

1. fit with the authoritative owner and local-first/offline behavior;
2. a smaller lifecycle and security burden than the code it replaces;
3. maintained releases, compatible licensing, typed interfaces, and a testable failure model;
4. a thin Spark adapter so persisted data and product semantics do not become vendor-owned;
5. clean uninstall/rollback and a version/upgrade policy;
6. focused contract tests plus a private, default-disabled spike when runtime behavior is still uncertain.

Prefer finishing the existing foundations before introducing overlapping frameworks: oRPC for typed local transport, Vite+ for formatting/lint/type checks, dependency-cruiser for package boundaries, prek for local gates, Vitest/fast-check/Stryker for behavior assurance, and Knip/jscpd for non-blocking debt discovery. Knip, duplicate-code, and complexity reports remain advisory until their dynamic-entry false positives are classified and a reviewed baseline can be ratcheted. Do not introduce another durable scheduler, job broker, ORM, agent graph, or transport schema generator unless an isolated experiment proves the daemon/SQLite and current protocol boundaries cannot meet a measured requirement.

## Distribution model

Spark v0.1 has one public npm product: `@zendev-lab/spark`, exposing the `spark` executable. Source workspaces remain private implementation and owner boundaries; apps, Cockpit-private packages, protocol/runtime packages, experiments, and compatibility facades are not independently published merely because the product uses them.

The npm package is generated from the checked source tree and contains compiled JavaScript plus the complete runtime closure: dispatcher, native TUI, daemon, database migrations, and built Cockpit assets. It must not execute `.ts` from `node_modules`, depend on an unpublished workspace package, discover a sibling checkout, or require the repository's `PATH`. The source root may remain private as a monorepo safety boundary; the generated package manifest is the public release contract.

The distribution stage of `pnpm run check` validates the explicit public-product/internal-workspace classification and the generated manifest contract. `pnpm run test:process:source` exercises the exact source-distributed dispatcher and daemon lifecycle under an isolated `SPARK_HOME`. `pnpm run smoke` reuses that lifecycle contract against a packed, clean-installed product, then probes dispatcher help, native TUI help, Cockpit health, rendered HTTP shell, and referenced client assets. CI runs the source and product process contracts independently; both must pass before publication, and `pnpm run publish` publishes only that verified generated directory.

## Canonical examples

```bash
spark daemon session list --json
spark daemon session create --workspace <id> --json
spark daemon submit --session <session-id> --prompt <text> --json
spark daemon invocation list --status failed --since 24h --limit 50 --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation result <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
spark daemon invocation retry <invocation-id> --json
spark daemon invocation retention --before <iso-time> --limit 100 --json
spark daemon channel status --json
spark daemon events watch --json

spark cockpit status --json
spark cockpit task list --project <project-ref> --json
spark cockpit assign --session <session-id> --goal "..." --json

spark tui attach <session-id>
spark tui --help
```

Session identity and channel policy are specified in [`sessions-and-channels.md`](./sessions-and-channels.md).

## Invalid placements

These shapes are not canonical and must fail:

```bash
spark server status
spark daemon sessions list --all-workspaces
spark daemon task claim <task-ref>
spark daemon goal complete
spark cockpit invocation status <invocation-id>
spark cockpit events watch
spark cockpit session create
spark tui task list
spark gateway ...
```

State commands must provide stable `--json` output. Human-readable output is not an automation contract. CLI owns canonical placement; slash commands are interactive aliases. Zellij is an operator validation tool, never a runtime dependency.
