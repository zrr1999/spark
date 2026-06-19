# Spark daemon hard-cutover unification

Status: selected for implementation planning
Date: 2026-06-18

## Summary

Spark should have exactly one local/background runtime concept: **Spark daemon**.

The current split between Spark CLI's small `spark daemon ...` queue runner and
Navia's `navia-runner`/local-service daemon should be removed by hard cutover,
not hidden behind long-lived aliases. The implementation direction is to absorb
and rename the former Navia runner responsibilities into a single Spark daemon
process, then make Spark CLI/TUI/headless surfaces and the web cockpit connect to
that daemon.

The web cockpit remains a projection/cache UI for Spark-owned execution state.
It is not an execution authority and must not become a second runtime concept.
If a public web product name remains, it should be **Spark Cockpit** (or another
Spark-owned name), not a separate Navia runtime identity.

## Decision

1. **One user-facing runtime name: `spark daemon`.**
   - Remove active `navia-runner`, `navia daemon`, and "local Navia service"
     runtime vocabulary.
   - Keep `Navia` only as a historical migration/source label until the
     cockpit/protocol packages are renamed or archived.
2. **Use the former Navia runner implementation as the larger daemon base.**
   - It already owns local IPC, service lifecycle, server WebSocket protocol,
     workspace registration, command routing, cancellation, and Spark bridge
     projection emission.
   - The existing Spark CLI daemon queue is a useful small slice, but it is too
     narrow to be the target daemon.
3. **Fold Spark CLI daemon queue/session execution into the single daemon.**
   - The daemon owns durable session appends, invocation records, queue work,
     workspace connections, ask/review waits, task/workflow execution, and
     projection publication.
   - Spark CLI/TUI becomes a client that starts/wakes the daemon, submits turns,
     and renders the daemon event stream.
4. **Hard cut package/app/service names.**
   - Rename active runtime packages, apps, bins, sockets, launchd labels, docs,
     tests, and scripts rather than keeping dual public surfaces.
   - A one-time state migration is allowed; long-lived compatibility command
     trees are not.
5. **Keep execution truth in Spark stores.**
   - Spark `.spark/` task, run, artifact, ask, and review stores remain
     authoritative.
   - Cockpit SQLite/projection stores remain reconnect-safe mirrors and local
     routing/cache state.

## Why now

The repo currently has two daemon concepts:

- Spark CLI has a local-only file queue daemon documented as intentionally not a
  gateway/service surface in `apps/spark/README.md` and
  `docs/spark-daemon-reference.md`.
- Navia runner is a separate daemon/local service that already bridges web
  commands into Spark runtime primitives under `apps/navia-runner/`.

Keeping both would create two names for one operational concern: background
Spark execution. The user's explicit direction for this project is a thorough
hard cutover with no parallel runner concept.

## External reference lessons

### nyakore: one runtime core, product definitions outside core

nyakore's README states that it is a "runtime core only" and does not own agent
definitions, prompts, or product-specific behavior
([README.md#L3](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/README.md#L3)).
It also requires `src/core/` to stay small and move subsystems out rather than
letting core become a grab bag
([README.md#L36](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/README.md#L36)).

Spark should copy that split: a small daemon kernel plus adapters for TUI, web
cockpit, skills, workflows, and providers. Spark daemon should not own
product-specific workflow policy; Spark modes/tasks/workflows own that policy.

### nyakore: one long-running entrypoint can own worker and gateway locks

nyakore documents `nyakore gateway run` as the normal background entrypoint, and
that it acquires both gateway and daemon locks so a separate worker-only daemon
cannot run for the same data root
([README.md#L156](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/README.md#L156)).
The code acquires both locks in `src/app/gateway.ts`
([gateway.ts#L233-L239](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/src/app/gateway.ts#L233-L239)).

Spark should have one daemon process/lock for the runtime root. Any web/cockpit
protocol adapter runs inside or alongside that daemon ownership, not as another
runtime owner.

### nyakore: transparent file queue and active-session de-duplication

nyakore's local queue uses readable `inbox`, `processed`, and `failed` folders
([queue.ts#L31-L47](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/src/core/queue.ts#L31-L47))
and marks terminal files by rename
([queue.ts#L68-L73](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/src/core/queue.ts#L68-L73)).
Its queue worker tracks active files and active sessions so the same session is
not executed concurrently
([queue-worker.ts#L158-L183](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/src/app/queue-worker.ts#L158-L183)).

Spark should keep this property because Spark JSONL session files are append
oriented. A single daemon must serialize or reject same-session turns.

### nyakore: loop order is explicit and observable

nyakore's worker loop sweeps waiters, wakes, schedules, processed mailbox, then
queue and scheduler work, and sleeps 250 ms when idle
([runtime-worker.ts#L95-L110](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/src/app/runtime-worker.ts#L95-L110),
[runtime-worker.ts#L183-L193](https://github.com/ShigureLab/nyakore/blob/2e7f7f692d331ded718b29d5ccd9d723f666cc71/src/app/runtime-worker.ts#L183-L193)).

Spark daemon should expose the same kind of loop structure in code and status:
waits, wakes/schedules, queue, invocations, projection outbox, then idle.

### agent-skills and Superpowers: lifecycle is command/skill policy, not daemon identity

Addy Osmani's `agent-skills` maps development lifecycle into a small set of
commands and auto-activated skills
([README.md#L10-L36](https://github.com/addyosmani/agent-skills/blob/a5f0b176381e9fea24a61aefc243506686aa2435/README.md#L10-L36)).
Superpowers treats workflows as mandatory methods layered on harness-native
skills; its Pi integration uses native skills rather than a compatibility Skill
tool
([README.md#L200-L218](https://github.com/obra/superpowers/blob/b62616fc12f6a007c6fd5118146821d748da0d33/README.md#L200-L218)).

Spark should keep `/plan`, `/implement`, `/goal`, `/workflow`, and skills as
policy/tooling above the daemon. They should not multiply runtime concepts.

### architect-loop: isolated workers and gates are workflow policy

architect-loop's core pattern is spec/gates first, isolated worktree builders,
architect review, and repo-backed memory
([README.md#L38-L52](https://github.com/DanMcInerney/architect-loop/blob/e6da696c2767bacbaeca00b676ec10a6a8f06893/README.md#L38-L52)).
Those are valuable workflow strategies for Spark tasks, but they belong in
Spark workflow/task policy, not in daemon core.

### snow-cli: one CLI may expose TUI, headless, async, and service modes

snow-cli documents background async tasks that do not block the terminal
([Async Task Management#L3-L14](https://github.com/MayDay-wpf/snow-cli/blob/b4c7cf1abf3b53cf9efc1c9327e5b044aac754cf/docs/usage/en/15.Async%20Task%20Management.md#L3-L14))
and SSE service mode as a continuously running backend distinct from one-shot
headless mode
([SSE Service Mode#L1516-L1518](https://github.com/MayDay-wpf/snow-cli/blob/b4c7cf1abf3b53cf9efc1c9327e5b044aac754cf/docs/usage/en/20.SSE%20Service%20Mode.md#L1516-L1518)).
It also keeps sensitive command confirmation even under YOLO mode
([SSE Service Mode#L127-L130](https://github.com/MayDay-wpf/snow-cli/blob/b4c7cf1abf3b53cf9efc1c9327e5b044aac754cf/docs/usage/en/20.SSE%20Service%20Mode.md#L127-L130)).

Spark can expose TUI, headless, async task, and cockpit clients, but they should
all connect to one daemon. The daemon must still preserve approval/ask/review
boundaries.

### pi-spark: UI polish belongs at client/extension layer

pi-spark focuses on TUI/editor/footer/presets/recap/web convenience features
([README.md#L25-L79](https://github.com/zlliang/pi-spark/blob/e93bf391c26afad3e8bf84123d26f1f2a9626a60/README.md#L25-L79))
with user-level feature configuration
([README.md#L81-L167](https://github.com/zlliang/pi-spark/blob/e93bf391c26afad3e8bf84123d26f1f2a9626a60/README.md#L81-L167)).
Spark daemon should not absorb client presentation features; Spark CLI/TUI and
extensions own those.

## Target architecture

```text
spark CLI / TUI / headless / cockpit clients
        │
        │ local IPC: $SPARK_HOME/run/daemon.sock
        ▼
spark daemon
  ├─ daemon kernel
  │   ├─ exclusive lock: $SPARK_HOME/runtime/daemon.lock
  │   ├─ worker loop: waits → wakes/schedules → queue → invocations → outbox
  │   ├─ active session/invocation registry
  │   └─ structured JSON logs/status
  ├─ local IPC server
  │   ├─ daemon.status / daemon.stop / daemon.logs
  │   ├─ turn.submit / turn.cancel / turn.events
  │   ├─ session.list / session.resume / session.branch
  │   ├─ workspace.register / workspace.list / workspace.detach
  │   └─ invocation.list / invocation.inspect / invocation.cancel
  ├─ execution engines
  │   ├─ SparkAgentSession headless turns
  │   ├─ task/workflow runtime
  │   ├─ native role-run executor
  │   └─ ask/review wait registry
  ├─ queue/state
  │   ├─ $SPARK_HOME/daemon/inbox/*.json
  │   ├─ $SPARK_HOME/daemon/processed/*.json
  │   ├─ $SPARK_HOME/daemon/failed/*.json
  │   └─ daemon DB for credentials/protocol/outbox/waits when JSON files are not enough
  └─ cockpit protocol adapter
      ├─ outbound server WebSocket session
      ├─ command delivery ack/reject
      ├─ task graph / invocation / artifact projections
      ├─ human request/response delivery
      └─ reconnect/replay idempotency
```

## State ownership

| Area | Owner after cutover | Storage | Notes |
| --- | --- | --- | --- |
| Spark session transcript appends | Spark daemon | `$SPARK_HOME/sessions/**` | CLI/TUI/headless submit through daemon IPC. |
| Spark task graph/TODO/run state | Spark daemon through Spark APIs | `.spark/` stores | Web cockpit never writes execution truth directly. |
| Role/task invocation lifecycle | Spark daemon | daemon invocation registry + Spark run records | Supports cancellation, logs, timeout, projection. |
| Ask/review waits | Spark daemon | daemon wait registry + Spark ask/review artifacts | Human answers resume waits; no ack-only placeholder. |
| Cockpit project/dashboard rows | Spark cockpit/server | cockpit SQLite | Routing/projection grouping, not Spark task graph authority. |
| Protocol delivery receipts | Spark cockpit/server and daemon outbox | cockpit SQLite + daemon DB | Reconnect-safe idempotency. |
| Credentials/tokens | Spark daemon | private config/DB under `$SPARK_HOME` | One-time import from old Navia runner paths. |

## Command surface

### Public commands

```text
spark                         # TUI client; starts/wakes daemon
spark -p/--print <prompt>      # headless daemon submit
spark daemon status [--json]
spark daemon start
spark daemon stop [--yes]
spark daemon logs [--follow]
spark daemon queue [--state inbox|processed|failed|all]
spark daemon submit --session <id> --prompt <text> [--json]
spark workspace register <path> --server-url <url> --token <token> --name <name>
spark workspace list|show|detach
```

### Retired command concepts

```text
navia daemon ...              # remove; one-time migration note only
navia ws ...                  # remove or turn into a short-lived external shim package only if release requires it
spark daemon enqueue/run      # replace with submit/start/queue verbs in the unified daemon
```

If a temporary external shim is required for a published package transition, it
must be a separate deprecation package that execs `spark ...` and is not used
inside this repo's tests/docs as a normal path.

## Rename and migration inventory

### Packages and apps

| Current | Target | Action |
| --- | --- | --- |
| `apps/navia-runner` | `apps/spark-daemon` | Rename; becomes daemon implementation base. |
| `@zendev-lab/navia-runner` | `@zendev-lab/spark-daemon` | Rename package; publish as daemon package if public. |
| `apps/navia-web` | `apps/spark-cockpit` | Rename for no-dual-product concept, or document as temporary legacy source path until renamed. |
| `@zendev-lab/navia-web` | `@zendev-lab/spark-cockpit` | Rename with cockpit package. |
| `@zendev-lab/navia-protocol` | `@zendev-lab/spark-cockpit-protocol` or `@zendev-lab/spark-daemon-protocol` | Rename if public schemas expose runtime identity. |
| `@zendev-lab/navia-db` | `@zendev-lab/spark-cockpit-db` | Rename if package remains public/internal. |
| `@zendev-lab/navia-domain` | `@zendev-lab/spark-cockpit-domain` | Rename or fold into cockpit app. |
| `@zendev-lab/navia-system` | `@zendev-lab/spark-daemon-system` or fold into daemon | Rename helpers that resolve daemon paths/secrets. |
| `@zendev-lab/navia-ui` | `@zendev-lab/spark-cockpit-ui` | Rename if retained. |
| `apps/spark/src/host/daemon/*` | `apps/spark-daemon/src/...` or `packages/spark-daemon-core` | Fold into single daemon; delete duplicate old path when callers are migrated. |

### Binaries, scripts, and service names

| Current | Target | Action |
| --- | --- | --- |
| `navia` binary for daemon/workspace ops | `spark workspace ...` / `spark daemon ...` | Remove as active repo path; optional external shim only. |
| `scripts/link-navia-runner.mjs` | `scripts/link-spark-daemon.mjs` | Rename/update. |
| root scripts `navia:runner`, `navia:install`, `navia:e2e`, `navia:build` | `daemon:*` / `cockpit:*` / `spark-cockpit:*` | Rename to Spark-owned groups. |
| launchd label `dev.navia.runner` | `dev.spark.daemon` | Rename and migrate/bootout old label. |
| socket `runner.sock` | `daemon.sock` | Rename with one-time cleanup/migration. |
| installation id prefix `navia-runner-` | `spark-daemon-` or `sdm_` | Rename; migrate existing ids without duplicating installations. |
| temp/test prefixes `navia-runner-*` | `spark-daemon-*` | Rename tests. |

### Source paths with active old concepts

Initial grep evidence found active old runtime references in these categories:

- Root metadata/docs: `README.md`, `AGENTS.md`, `package.json`,
  `scripts/link-navia-runner.mjs`.
- Spark CLI daemon docs/code: `apps/spark/README.md`,
  `apps/spark/src/cli.ts`, `apps/spark/src/cli/daemon.ts`,
  `apps/spark/src/host/daemon/*`, `test/spark-daemon-*.test.ts`.
- Former runner app: `apps/navia-runner/package.json`, `README.md`,
  `src/cli.ts`, `src/config.ts`, `src/daemon.ts`, `src/local-rpc.ts`,
  `src/service.ts`, `src/spark/bridge.ts`, and their `*.test.ts` files.
- Cockpit/server docs and code: `docs/navia/**`,
  `apps/navia-web/src/lib/i18n/en.json`,
  `apps/navia-web/src/lib/server/package-boundaries.test.ts`.
- Release docs: `docs/navia/docs/release/*`,
  `docs/navia/docs/plans/release-roadmap.md`.
- Boundary checks: `scripts/check-pi-boundaries.mjs` and
  `test/check-pi-boundaries.test.ts` need updated package direction rules.

The implementation tasks should treat this list as a minimum. Each rename task
must re-run grep for `navia-runner`, `Navia runner`, `local Navia service`,
`runner.sock`, `dev.navia.runner`, and `@zendev-lab/navia-` to classify/remove
remaining active references.

## Implementation consequences

### Replace the old Spark daemon slice

The current `apps/spark/src/host/daemon/*` and `apps/spark/src/cli/daemon.ts`
were intentionally scoped as a local queue-only slice. After this decision,
those files are not the final daemon boundary. Their useful mechanics should be
moved into the renamed Spark daemon package, then the old command surface should
be deleted or converted to a thin client of the new daemon.

### Replace the former Navia runner identity

The current former-runner code has the right daemon capabilities but the wrong
identity. The hard cut should rename it rather than wrapping it:

- `startRunnerDaemon` → `startSparkDaemon`
- `RunnerConfig` → `SparkDaemonConfig`
- `startRunnerService` → `startSparkDaemonService`
- `localRpcSocketPath(...)/runner.sock` → daemon socket
- `runNaviaCommandThroughSpark` → daemon/cockpit command bridge name
- `Navia runner bridge` prompt/copy → `Spark daemon bridge`

### Make Spark CLI a daemon client

Spark CLI no longer constructs an independent execution host for ordinary
turns. The hard-cut client behavior is:

1. `spark` TUI uses an injected daemon responder instead of `createSparkCliHostServices()`;
2. `spark --print <prompt>` submits a headless `turn.submit` request;
3. `spark daemon start/status/submit/queue` starts/wakes and talks to the daemon local IPC socket;
4. `spark daemon enqueue/run` are retired in favor of `submit/start`;
5. durable session appends remain daemon-owned, with the TUI acting as presentation/input only.

Streamed event rendering, cancellation, answers, and steering still need follow-up IPC methods beyond the initial submit/status/queue client path.

### Native headless role execution is part of completion

Current Spark runtime role execution still defaults to spawning `pi` for child
role runs. That creates another hidden runtime owner. The hard-cut target must
provide a daemon-native non-TUI executor before the goal can be considered
complete. Pi extension host support remains valid when Spark is loaded inside
Pi, but Spark daemon should not depend on `pi --print --mode json` as its
default background executor.

### Human wait bridge is required

The former runner currently acknowledges delivered human responses without
returning to an active tool wait. The target daemon must own wait records for
ask/review/tool calls, project those waits to the cockpit inbox, and resume or
fail the exact blocked invocation when an answer arrives. No elapsed-time or
liveness rule may auto-answer human decisions.

## Validation policy

Every implementation slice should include both targeted tests and vocabulary
checks. The final validation task must include:

```text
pnpm run check:boundaries
pnpm run check:tsc
pnpm test
pnpm run verify:navia          # or renamed cockpit/daemon equivalent
pnpm run verify:merged
```

Plus grep/classification checks for:

```text
navia-runner
Navia runner
local Navia service
runner.sock
dev.navia.runner
@zendev-lab/navia-runner
spark daemon - local daemon-only queue runner
No gateway/HTTP/service commands are provided
```

Remaining occurrences must be one of:

- historical migration note;
- changelog/release note explicitly documenting the removal;
- fixture proving the migration rejects/imports old state;
- external URL/title that cannot be renamed.

No active source, command help, package metadata, docs, UI copy, or tests should
present Navia runner/local service as a runtime concept after cutover.

## Follow-up task mapping

This ADR supports the current durable task plan:

1. `daemon-cutover-adr-inventory` records this decision and inventory.
2. `spark-daemon-package-rename` renames active runtime packages/apps/scripts.
3. `single-daemon-core` merges Spark queue/session execution with the former
   runner service into one daemon core.
4. `spark-cli-links-daemon` makes Spark CLI/TUI clients of the daemon.
5. `cockpit-protocol-vocabulary-cutover` removes old runner/local-service
   vocabulary from cockpit/protocol surfaces.
6. `daemon-human-wait-bridge` makes ask/review waits daemon-owned.
7. `native-headless-role-executor` removes the Pi CLI child-runner default.
8. `state-migration-and-legacy-deletion` imports/archives old state and deletes
   active legacy tails.
9. `final-unification-validation-docs` proves no dual concept remains.
