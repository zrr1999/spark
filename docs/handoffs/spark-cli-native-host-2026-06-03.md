# Handoff: Spark CLI native pi-tui host

**Date:** 2026-06-03
**Project:** `proj:422978b6-936a-4237-b0f1-f49f8b86d80b` — _Spark CLI native pi-tui host_
**Outgoing session:** completed 6/17 tasks in this work-stream (foundation layer)
**For:** any agent (human or otherwise) taking over the next task

> Read this in full before claiming a task. It captures decisions that are **not** obvious from the code and warns about pitfalls that already cost the previous session debugging time.

---

## 1. Goal of the project

Decouple `packages/spark-cli` from the `@earendil-works/pi-coding-agent` SDK runtime and stand up a **native pi-tui host** that is feature-equivalent for the Spark CLI use case:

- Implements `ExtensionAPI` (the contract in `packages/pi-extension-api`) so the same Spark / pi-cue / pi-graft / pi-roles / pi-ask extensions can run unchanged in two hosts: the upstream Pi coding-agent **and** the new spark-cli native host.
- Owns its own agent turn loop, session+branch+compaction store, keybindings, providers, skills, and TUI rendering.
- Loads providers (`pi-ai` family + `baidu-oneapi`) as plugins through `~/.spark/config.json`.

The Pi extension entry point `packages/spark/src/extension/index.ts` keeps working unchanged in upstream Pi — host-pluralism is the design tenet.

---

## 2. Current state at handoff

| Statistic                          | Value                           |
| ---------------------------------- | ------------------------------- |
| Tasks total                        | 17                              |
| Done                               | 6                               |
| Pending                            | 11                              |
| Lines of new code added            | ~1900                           |
| New tests                          | ~95 (across 7 host-suite files) |
| Test pass rate (host suites only)  | 100%                            |
| Repo-wide tsc / full `node --test` | **RED** — pre-existing, see §7  |

Active project ref: `proj:422978b6-936a-4237-b0f1-f49f8b86d80b`.

Current Spark project for the next agent's session must be set explicitly via `spark_use_project`. The other open projects (`Spark mode-as-state UX rework` in particular) are independent work-streams; do **not** mix tasks across them.

---

## 3. Architecture map (after the 6 completed tasks)

```
~/.spark/
├── config.json                  ← SparkConfig: extensions[], providers[], activeProvider/Model
├── agent/keybindings.json       ← user override of default keybindings
├── sessions/<workspaceHash>/    ← (NOT YET IMPLEMENTED — task @session-format-and-store)
│   └── <sessionId>.json
└── skills/                      ← (NOT YET IMPLEMENTED — task @skill-loader)

packages/pi-extension-api/       ← types-only contract; v0.1.0; no runtime
└── src/index.ts                   ExtensionAPI (all methods optional), ExtensionContext, ToolConfig, etc.

packages/spark-cli/src/host/
├── types.ts                     ← UI transport stub, SessionManager stub, OutboxEnvelope
├── runtime.ts                   ← SparkHostRuntime: implements ExtensionAPI + host-only surface
├── agent-loop.ts                ← SparkAgentLoop: stream→tool→stream loop, abort, outbox drain
├── keybindings.ts               ← SparkKeybindings: defaults + override + most-recent-wins
├── provider-registry.ts         ← ProviderRegistrationAPI + SparkProviderRegistry + ProviderConfig
├── config.ts                    ← SparkConfig schema + load/save (atomic temp+rename)
├── plugin-loader.ts             ← unified extensions[]/providers[] loader (import-default + isolation)
└── index.ts                     ← barrel
```

The boot sequence the **next** agent will eventually wire (in `@migrate-spark-cli-deps`):

```
loadSparkConfig(~/.spark/config.json)
    ↓
new SparkHostRuntime({ cwd, hasUI: true, ui, sessionManager, keybindings })
new SparkProviderRegistry()
loadPlugins({ extensionApi: hostRuntime, providerApi: registry, extensions, providers })
hostRuntime.getKeybindings().loadFromDisk()
registry.setActive({ providerName: config.activeProvider, modelId: config.activeModel })
new SparkAgentLoop({ host, getModel: () => registry.buildActiveModel(), stream: piAi.stream })
TUI mounts → reads hostRuntime.peekOutbox() / drainOutbox() to render messages
```

That boot path doesn't exist yet. The **components** are unit-tested in isolation; integration is the next mile.

---

## 4. The 6 done tasks (do not redo)

### Task 1 · `@extension-api-shared` (`task:7f56ab9f`) — DONE

- **Outcome:** new package `packages/pi-extension-api` (types-only, no runtime, no deps).
- **Why:** removes the `@earendil-works/pi-coding-agent` import from extension TS files. Both Pi and spark-cli now depend on the same contract package.
- **Decision:** **every method on `ExtensionAPI` is optional.** Hosts may implement subsets. Consumers must guard each call (`pi.registerTool?.(...)`).
- **Side effects executed:**
   - Deleted shims: `packages/{pi-ask,pi-cue,spark}/src/pi-types.d.ts`.
   - Removed `peerDependencies` + `peerDependenciesMeta` from 5 packages: `pi-ask`, `pi-cue`, `pi-graft`, `pi-roles`, `spark`.
   - Updated `tsconfig.base.json` paths and root `package.json`.

### Task 2 · `@merge-spark-ask-into-pi-ask` (`task:944f8fed`) — DONE

- **Outcome:** `packages/spark-ask/` is **deleted**. Its content was split:
   - `copy.ts` → `packages/spark-core/src/copy.ts` (renamed `SparkCopyLanguage` → `CopyLanguage`).
   - `tool.ts` (~330 lines) → `packages/spark/src/extension/spark-ask-tool.ts`. Public symbols still use the `Spark` prefix (`runSparkAskTool`, `SparkAskToolParams`, `MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH`); internally it consumes pi-ask names directly (`runPiAskFlow`, `replayPiAskFlow`, `createPiAskFlowRequest`).
- **Side effects:** rewrote 8 source imports + 3 test imports; updated 8 docs files; pnpm-lock + tsconfig.base + root + spark/package.json synced.

### Task 3 · `@host-api-runtime` (`task:33b0d6ec`) — DONE

- **Outcome:** `SparkHostRuntime` in `packages/spark-cli/src/host/runtime.ts` (~360 lines).
- **Implements** (ExtensionAPI subset): `registerTool`, `registerCommand` (auto `:n` suffix on duplicates per Pi convention), `registerShortcut` (added in task 5), `on`, `sendMessage`, `sendUserMessage`, `getAllTools` (filters `active=true`), `setActiveTools`.
- **Host-only surface:** `setUiTransport`, `setSessionManager`, `emit(event)`, `drainOutbox`/`peekOutbox`, `makeContext`, `isIdle`/`setIdle`, `onToolRegistration`, `listTools`/`getTool`, `listCommands`/`getCommand`, `executeKey`, `getKeybindings`.
- **Stubs throwing `not implemented`:** `registerFlag`, `registerMessageRenderer`, `setModel`, `setThinkingLevel`, `exec`. (Light them up in subsequent tasks.)
- **Tests:** 12 cases in `test/spark-host-runtime.test.ts` + 4 cross-extension cases in `test/spark-host-runtime-cross.test.ts` exercising real pi-cue / pi-graft / pi-ask plugins.

### Task 4 · `@agent-turn-loop` (`task:c4dbf738`) — DONE

- **Outcome:** `SparkAgentLoop` in `packages/spark-cli/src/host/agent-loop.ts` (~320 lines).
- **Constructor injects** the pi-ai stream function: `(model, context, options) => AsyncIterable<chunk>`. Decoupling stream means tests can mock without a real provider.
- **State machine:** `idle | streaming | tooling | aborting`; refuses concurrent `submit()`.
- **Tool dispatch:** looks up `host.getTool(name).config.execute()`. **Unknown tools** return `isError: true` `ToolResultMessage` (do not crash).
- **Outbox drain:** between rounds, `host.drainOutbox()` is converted to user messages and prepended to the next stream round.
- **maxRoundtrips = 16.**
- **🛑 Pitfall (already-fixed):** initial implementation detected outbox-drain by comparing `context.messages.length === this.messages.length`, but they are the **same array reference**, so the diff was always 0. Fixed by snapshotting `messageCountBeforeAssistant` before each round. **Do not regress this.**
- **Tests:** 6 cases in `test/spark-agent-loop.test.ts`.

### Task 5 · `@host-keybindings-manager` (`task:6a3e1dba`) — DONE

- **Outcome:** `SparkKeybindings` in `packages/spark-cli/src/host/keybindings.ts` (~240 lines) + integration into `SparkHostRuntime`.
- **Default keybindings (6 baseline):**
   - `app.exit` → `ctrl+c`
   - `app.thinking.cycle` → `shift+tab`
   - `app.toggleTools` → `ctrl+o`
   - `app.toggleThinking` → `ctrl+t`
   - `app.modelPicker` → `ctrl+l`
   - `app.abortTurn` → `esc`
   - All handlers are placeholder no-ops; subsequent tasks (model-selector / tool-rendering / mode-state) replace them.
- **Most-recent-registration wins** when the same key is bound multiple times. This is how the upcoming Spark mode-as-state work installs `app.spark.cycleMode` on `shift+tab` to override `app.thinking.cycle` only when Spark is active. The losing binding's `isActive(ctx)` gate decides who wins on each event.
- **Persistence:** `~/.spark/agent/keybindings.json` (path overridable via `SPARK_AGENT_DIR`). Two acceptable JSON shapes accepted on read: `{ "bindings": { id: key } }` (canonical) and flat `{ id: key }` (legacy/manual). Save uses canonical. Missing files silently load defaults.
- **Tests:** 10 cases in `test/spark-keybindings.test.ts` + 3 in host-runtime suite.

### Task 6 · `@provider-config-and-pi-ai-wiring` (`task:0c61a712`) — DONE

- **Outcome:** three host-side modules totalling ~360 lines.
- **`provider-registry.ts`:** formalizes `ProviderRegistrationAPI = { registerProvider(name, ProviderConfig): void }` + `ProviderConfig = { name, baseUrl, apiKey?, api, streamSimple, models[] }`. Matches the **existing** `packages/spark-cli/src/baidu-oneapi-provider.ts` shape exactly — the canonical baidu-oneapi plugin plugs in unchanged.
- **`SparkProviderRegistry`** methods: `registerProvider`, `hasProvider`, `getProvider`, `listProviders`, `listModelsFor`, `setActive` (validates existence — never silent), `getActive`, `buildModel(provider, modelId)` returns a pi-ai-compatible `Model<Api>`, `buildActiveModel`.
- **`config.ts`:** `SparkConfig = { extensions[], providers[], activeProvider?, activeModel?, activeThinkingLevel? }`. `DEFAULT_SPARK_CONFIG.extensions = ["spark/extension","pi-cue","pi-graft","pi-roles","pi-ask"]`. `DEFAULT_SPARK_CONFIG.providers = ["spark-cli/baidu-oneapi-provider"]`. Missing/malformed JSON returns defaults — never throws on a fresh user box. `saveSparkConfig` uses atomic temp+rename. `SPARK_HOME` env var overrides `~/.spark`.
- **`plugin-loader.ts`:** `loadPlugins({ extensionApi, providerApi, extensions[], providers[], importer? })`. Uses the same `import(specifier)` machinery for both lists but injects different APIs. **Errors are isolated** — a failing plugin does not stop subsequent ones; the result `LoadResult { outcomes[] }` carries success/failure per specifier. Custom `importer` overridable for tests.
- **Tests:** 15 cases across `test/spark-provider-registry.test.ts` (6, including real `baidu-oneapi-provider` plug), `test/spark-config.test.ts` (4), `test/spark-plugin-loader.test.ts` (5).

---

## 5. The 11 remaining tasks — concrete starting points

Pull each task entry below verbatim into your scratchpad before claiming.

### Ready (no blockers)

#### `@model-selector-ui` — `task:3cf0d6fd-2a59-47e0-bec9-133089289a6c`

- **Goal:** Ctrl+L model selector using `pi-tui`'s `SelectList` component.
- **Inputs:**
   - `SparkProviderRegistry.listProviders()` for top-level group; per-provider `listModelsFor()` for sub-list.
   - Currently active selection: `registry.getActive()`.
- **Outputs:** on selection: `registry.setActive({ providerName, modelId })` → mutate `SparkConfig.activeProvider/activeModel` → `saveSparkConfig`.
- **Keybindings to register** (replace placeholders in `SparkKeybindings` defaults):
   - `app.modelPicker (ctrl+l)` opens picker.
   - `app.modelCycle.next (ctrl+p)` and `app.modelCycle.prev (shift+ctrl+p)` cycle through current provider's models without opening UI.
- **Files to create:** `packages/spark-cli/src/host/model-selector.ts` (logic) + a `pi-tui` component wrapper. Place TUI components in `packages/spark-cli/src/tui/`.
- **Test:** `test/spark-model-selector.test.ts` covering cycle next/prev wraparound and selection persistence (mock `saveSparkConfig`).

#### `@tool-and-thinking-rendering` — `task:3c95a7f6`

- **Goal:** in `SparkNativeTuiApp`, render: (1) folded tool-call blocks (Ctrl+O global toggle), (2) thinking blocks (Ctrl+T toggle), (3) custom message types via `registerMessageRenderer` (currently stubbed), (4) smooth streaming chunk append.
- `registerMessageRenderer` currently throws `NOT_IMPLEMENTED` in `SparkHostRuntime`. Light it up: store renderers by `customType`, expose to TUI.
- Wire `app.toggleTools` and `app.toggleThinking` keybindings to UI state.

#### `@session-format-and-store` — `task:34ee54f2`

- **Goal:** clone Pi's session+branch JSON format to `~/.spark/sessions/<workspaceHash>/<sessionId>.json`.
- Fields: `messages`, `branches`, `activeBranchId`, `model`, `thinking`, `createdAt`, `updatedAt`, `tools state`.
- Provide `SessionStore` (load/save/list).
- **Do NOT share** `~/.pi/sessions` — separate dirs, shared format.
- CLI starts in resume mode unless `--new`.
- **Reference:** look at upstream Pi's session writer for exact key names. **DO NOT INVENT** — exact compat matters for cross-debugging.

#### `@skill-loader` — `task:866001af`

- **Goal:** three-tier `SkillResolver`: builtin (`packages/spark/skills/**`) + workspace (`<cwd>/.spark/skills/**`) + user (`~/.spark/skills/**`).
- Frontmatter parse: `name`, `description`, `disabled`.
- Description-driven loading (inject SKILL.md body into system prompt or tool context only when needed).
- Priority: `user > workspace > builtin` for same name.
- Match Pi's discovery rules.

#### `@extension-loader-and-wiring` — `task:93fa3197`

- **Goal:** wire the `loadPlugins` function (already built in task 6) into a real cli boot path. Resolve specifiers `spark/extension`, `pi-cue`, etc. against `node_modules` / workspace. Remove `loadPiSdk` from `cli.ts`.

#### `@pi-ext-compat-tests` — `task:ad7b09c1`

- **Goal:** `test/spark-ext-host-contract.test.ts` runs the same extension behaviour against (a) a lightweight `PiExtensionApiAdapter` (mock pi-coding-agent minimal subset) and (b) `SparkHostRuntime`. Assert event sequences and tool results match.
- This test is the **dual-host invariant** — protect it.

### Blocked or chained

#### `@session-branch-tree-nav` — `task:ba88982c`

Depends on session store. `pi-tui SelectList` for branch tree; `/sessions list/branch/switch` commands.

#### `@compaction` — `task:9db34bdb`

Depends on session store. Token-threshold or explicit trigger; fold old messages into one summary, keep `originalMessageIds` ref. Copy Pi's algorithm.

#### `@migrate-spark-cli-deps` — `task:55c21562`

Depends on the bulk of host work being done. Drop `@earendil-works/pi-coding-agent` from `packages/spark-cli/package.json`. Rewrite `cli.ts` to compose the boot path described in §3.

#### `@docs-publishing` — `task:14b381e4`

Update root README, `packages/spark-cli/README.md`, `packages/pi-extension-api/README.md`, `AGENTS.md`, add `docs/spark-host-architecture.md`, prepend a paragraph to `SKILL.md`.

#### `@verify-cli-mvp` — `task:fa842255`

Depends on everything. Full suite, e2e smoke (real baidu-oneapi conversation, Ctrl+L, Shift+Tab, /sessions, restart resume), Pi extension regression, `grep -rn '@earendil-works/pi-coding-agent' packages/spark-cli` ⇒ 0. Aggregate to `.spark/notes/cli-rework-smoke.md`.

- **Pre-warning:** this task is currently blocked by the spark-learnings issue described in §7. Resolve that first or have it explicitly waived.

---

## 6. Conventions established (follow these)

1. **All host source files live in `packages/spark-cli/src/host/`.** TUI components go in `packages/spark-cli/src/tui/`.
2. **Host-only surface vs ExtensionAPI surface stays distinct.** Anything an extension calls goes through `pi-extension-api`. Anything only the host calls is a plain method on `SparkHostRuntime` and is **not** added to the contract.
3. **Tests use `node --experimental-strip-types --test test/<file>.test.ts`.** No vitest, no jest.
4. **Imports** of pi-ai use `@earendil-works/pi-ai` directly — that package stays. Provider plugins keep their `import { streamAnthropic } from "@earendil-works/pi-ai/anthropic"` etc. unchanged.
5. **Default exports for plugins:** an extension or provider plugin `default function(api): void | Promise<void>`.
6. **Atomic file writes:** all on-disk JSON uses temp + rename (see `saveSparkConfig`). Apply this pattern in session/skill writers.
7. **Failure isolation:** plugin loading, tool dispatch, key handling all isolate one failure from others. Mirror this when adding new registries.
8. **`spark_ask` over guessing:** if you discover an undocumented design choice mid-task, stop and ask the user. The previous session burned cycles regretting silent defaults.

---

## 7. Known blocker — _spark-learnings refactor mid-flight_

Another session left `packages/spark-learnings/src/index.ts` mid-refactor at 2026-06-02 13:03:29 with rename `LearningScope` → `LearningLocation`. Four consumers were not migrated:

- `packages/spark/src/tools/learning-tool-registration.ts`
- `packages/spark/src/tools/learning-tools.ts`
- `packages/spark/src/tools/spark-finish-task-tool-registration.ts`
- `test/learnings-store.test.ts`

**Symptoms:**

- `pnpm run check:tsc` reports ~16 errors across those files.
- `node --test` for `test/spark-init.test.ts` and `test/spark-tools.test.ts` fails through transitive imports.

**The previous session's user explicitly waived this** via `spark_ask` artifact `artifact:f286c1d1` (`ignore_continue`). The host-suite tasks above all run green in isolation **because** they do not import spark-learnings transitively.

**For `@verify-cli-mvp`:** this MUST be resolved before that task can pass. Either:

- Finish the four-file rename to `LearningLocation`, **or**
- Get an explicit user decision to roll back `LearningScope` → `LearningLocation` in `packages/spark-learnings/src/index.ts`.

Do not try a partial fix — pick one direction and apply consistently.

---

## 8. Pitfalls catalogue

| #   | Pitfall                                                                                    | Where                                               | How to avoid                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reference-shared array length comparison silently always returns 0                         | `agent-loop.ts` outbox drain                        | Snapshot `length` before mutating; never compare an array to itself                                                                         |
| 2   | Spark mode-as-state needs to win on `shift+tab` only when Spark is active                  | `keybindings.ts` most-recent-wins + `isActive` gate | Register Spark cycleMode AFTER the default thinking.cycle and provide an `isActive: () => sparkActive` predicate                            |
| 3   | `ExtensionAPI` methods are all optional                                                    | `pi-extension-api/src/index.ts`                     | Always guard: `pi.registerCommand?.(...)`. Hosts may legitimately not implement a method                                                    |
| 4   | Same-named extensions imported by both Pi and spark-cli must produce identical event order | dual-host invariant                                 | Run `@pi-ext-compat-tests` after any host-runtime change                                                                                    |
| 5   | Provider plugins use `streamSimple` not `stream`                                           | `provider-registry.ts`                              | The `Model<Api>` returned by `buildModel` is fed to a stream function the SparkAgentLoop receives via injection, NOT through ProviderConfig |
| 6   | Task claim leases expire on long planning calls                                            | spark task lifecycle                                | Re-claim before finishing; the previous session lost a claim during plan editing once                                                       |
| 7   | `~/.spark/sessions` is **separate** from `~/.pi/sessions`                                  | session store design                                | Do NOT cross-read; share JSON format only                                                                                                   |
| 8   | `CopyLanguage` was `SparkCopyLanguage` until task 2                                        | spark-core renames                                  | All consumers already updated; new code uses `CopyLanguage`                                                                                 |
| 9   | `node_modules/.bin/pi` shims still reference pi-coding-agent on dev boxes                  | install caching                                     | Will clear on next `rm -rf node_modules && pnpm install`. Not a runtime risk                                                                |

---

## 9. Open design decisions deferred to future tasks

Recorded so the next agent doesn't waste cycles re-deciding:

1. **OAuth flow for provider API keys** — `SparkConfig.providers[*].apiKey` accepts env var name or literal; `oauth:<provider>` is reserved but **not implemented**. Decide format when adding the second non-baidu provider.
2. **Pi-ai 8 builtin providers default registration** — anthropic / openai-completions / openai-responses / google / mistral / bedrock / openai-codex / azure-openai-responses are NOT auto-registered. The task description suggests `wirePiAiBuiltinProviders(registry, providerNames)` helper. Defer until at least one external user requests it; baidu-oneapi covers the common case.
3. **Compaction trigger threshold** — Pi's algorithm is the spec. Token threshold default TBD with the user when that task starts.
4. **Skill activation mode** — description-driven means we inject SKILL.md only on demand. Decide injection point: system prompt prepend vs tool context attach vs both.
5. **Session resume default** — `--new` to force a new session is settled. The default path when `~/.spark/sessions/<hash>/` exists is "resume newest", but the policy on dirty/abandoned sessions is open.
6. **ExtensionAPI version pin** — `pi-extension-api` is `0.1.0`. When breaking the contract becomes necessary, decide a SemVer policy (loose for 0.x; tight after 1.0).

---

## 10. How to run things (next-agent quick start)

```sh
# Install (offline-friendly when lockfile exists)
pnpm install --offline --lockfile-only --ignore-scripts

# Type-check (will be RED until spark-learnings is resolved — see §7)
./node_modules/.bin/tsc -p tsconfig.json --noEmit

# Run JUST the host-suite tests (these are GREEN today)
node --experimental-strip-types --test \
  test/spark-host-runtime.test.ts \
  test/spark-host-runtime-cross.test.ts \
  test/spark-agent-loop.test.ts \
  test/spark-keybindings.test.ts \
  test/spark-provider-registry.test.ts \
  test/spark-config.test.ts \
  test/spark-plugin-loader.test.ts

# Inspect Spark project state
# (use Spark tools — spark_status, spark_list_projects, etc.)
```

To pick up where this handoff stops:

```text
# In Pi/Spark
spark_use_project project=proj:422978b6-936a-4237-b0f1-f49f8b86d80b
spark_status view=active
spark_claim_task title=<one of @model-selector-ui | @session-format-and-store | @skill-loader | @extension-loader-and-wiring | @tool-and-thinking-rendering | @pi-ext-compat-tests>
# read this handoff section §5 for that task's starting points
# implement, test, finish
spark_finish_task status=done summary="..."
```

---

## 11. Cross-references

- Companion project for mode work: `proj:4fef5f48-ae6a-4336-ae01-a052d4bbfb44` — _Spark mode-as-state UX rework_ (6 pending tasks; independent of this stream but shares the SparkKeybindings most-recent-wins design — task `@shift-tab-cycle` will install `app.spark.cycleMode`).
- Learning artifacts emitted during the 6 done tasks (search via `spark_learning_search`):
   - `artifact:learning-8c6c617ce4690616` (extension-api-shared)
   - `artifact:learning-91ff9d4106328197` (host-keybindings-manager)
   - `artifact:learning-657e503f29750ed3` (provider-config-and-pi-ai-wiring)
- Ask artifacts touched in this work-stream:
   - `artifact:f286c1d1` — spark-learnings ignore_continue waiver
- Project skill (must read before cross-project work): `packages/spark/skills/spark/SKILL.md`.

---

## 12. Final sign-off checklist for the next agent

- [ ] Read this entire handoff before claiming a task.
- [ ] Confirm `spark_status` matches §2 (17 tasks, 6 done, 11 pending).
- [ ] Run the host-suite test command from §10 — must report ~95 pass / 0 fail.
- [ ] Decide whether to address spark-learnings (§7) before or after `@verify-cli-mvp`.
- [ ] Pick exactly one task from §5; do not auto-batch unless using `/goal`.
- [ ] When in doubt about scope/architecture/dependency — `spark_ask`, not silent default.

Good luck. The foundation is built; the rest is rendering, persistence, and wiring.

— Outgoing session, 2026-06-03
