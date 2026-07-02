# Spark host architecture

Spark has two host targets that share extension packages through the extension API package. Current imports still use `spark-extension-api`; the selected target name is `spark-extension-api` as part of the staged Spark capability rename in [`spark-capabilities-and-generative-ui.md`](./spark-capabilities-and-generative-ui.md).

## Data flow

```text
                     ┌──────────────────────────────┐
                     │  Pi host                      │
                     │  @earendil-works/pi-coding-  │
                     │  agent extension runtime      │
                     └──────────────┬───────────────┘
                                    │ spark-extension-api
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│ Shared retained capability packages                                     │
│                                                                         │
│  spark-ask     spark-cue     spark-roles     spark-graft     spark-ext   │
│  ask tools     cue tools     role tools      graft tools     modes +     │
│  (currently pi-* names until staged rename)               Spark tools    │
└───────────────────────────────────▲───────────────────────────────────┘
                                    │ explicit factories
                                    │
                     ┌──────────────┴───────────────┐
                     │  Spark TUI native host        │
                     │  apps/spark-tui               │
                     └──────────────┬───────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       │                            │                            │
┌──────▼──────┐              ┌──────▼──────┐              ┌──────▼──────┐
│ pi-tui      │              │ spark-turn  │              │ spark-host  │
│ ProcessTerm │ user input   │ + pi-ai     │ tool calls   │ SparkHost-  │
│ TUI Editor  │─────────────▶│ provider    │─────────────▶│ Runtime     │
│ transcript  │◀────────────│ stream      │◀────────────│ tools/events│
└─────────────┘ assistant    └─────────────┘ tool result  │ outbox/UI   │
       ▲       output                                      └──────┬──────┘
       │                                                          │
       │                                                          │
       │     ┌────────────────────────────────────────────────────┼──────┐
       │     │                                                    │      │
┌──────┴──────┐     ┌────────────────────┐     ┌─────────────────▼──┐   │
│ Keybindings │     │ ProviderRegistry   │     │ ExtensionLoader     │   │
│ model picker│     │ baidu-oneapi etc.  │     │ explicit builtins   │   │
└─────────────┘     └────────────────────┘     └────────────────────┘   │
                                                                          │
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐   │
│ SkillResolver       │  │ SessionStore        │  │ SessionNavigation   │◀──┘
│ builtin             │  │ ~/.spark/sessions/  │  │ id/parentId branch  │
│ <cwd>/.spark/skills │  │ <workspaceHash>/    │  │ tree helpers        │
│ ~/.spark/skills     │  │ Pi JSONL v3 shape   │  │                    │
└────────────────────┘  └────────────────────┘  └────────────────────┘
```

## Host responsibilities

### Pi extension host

- Loads packages through Pi's manifest/package discovery.
- Owns Pi interactive mode, widgets, session manager, and Pi-specific UI.
- Runs the same retained extension packages through Pi's concrete extension runtime.

### Spark TUI native host

- Usually reached through the `apps/spark-cli/bin/spark` dispatcher, which routes `spark tui ...` to `spark-tui`; direct TUI boot starts with `apps/spark-tui/bin/spark-tui` and `apps/spark-tui/src/cli.ts`.
- Constructs native host services in `src/host/bootstrap.ts` using shared `@zendev-lab/spark-host` (`SparkHostRuntime`) and `@zendev-lab/spark-turn` (`SparkAgentLoop` / `SparkTurnRunner`).
- Loads retained builtin extensions through explicit imports in `SparkExtensionLoader`; it does not call Pi SDK discovery or `loadPiSdk`. The default builtin set is `@zendev-lab/spark-ask`, `@zendev-lab/spark-cue`, `@zendev-lab/spark-files`, `@zendev-lab/spark-ai` models extension, `@zendev-lab/spark-roles`, `@zendev-lab/spark-graft`, and `@zendev-lab/spark-extension`.
- Registers working-tree file tools (`read`/`write`/`edit`/`ls`/`grep`/`find`) natively through the `@zendev-lab/spark-files` extension. `cue_exec` remains the shell surface; there is no `bash` tool (spark-cue disables bash by policy).
- Registers providers through `SparkProviderRegistry` and runs turns through shared `spark-turn` plus `SparkAgentSession`; concrete provider streaming still uses `@earendil-works/pi-ai` behind the Spark-owned provider/stream function boundary.
- Owns terminal UI components through the `@zendev-lab/spark-tui` boundary and app-local `pi-tui` adapter.
- Stores native sessions as Pi-compatible JSONL v3 files under `~/.spark/sessions/<workspaceHash>/`.
- Shares the same host/turn core with daemon headless execution. The daemon owns the local queue under `~/.spark/daemon/` plus `~/.spark/runtime/daemon.lock` and runs `session.run` through Spark's headless session executor instead of `pi-coding-agent` sessions.
- Resolves workspace and user skills from `<cwd>/.spark/skills/**` and `~/.spark/skills/**`. Resolves prompt templates from `<cwd>/.spark/prompts/*.md`, `~/.spark/prompts/*.md`, and configured `promptTemplates` paths, then registers non-colliding templates as native slash commands. The Spark product no longer bundles project-idea/SPARK.md workflow prompts under `packages/spark-extension/skills/**`; those live in external skill repositories such as `zrr1999/skills`.

## Boundary rules

- Shared extension packages should import types from `spark-extension-api`, not runtime values from `@earendil-works/pi-coding-agent` or Spark app packages.
- Shared Spark host/turn behavior belongs in `packages/spark-host` and `packages/spark-turn`; app-level TUI wrappers belong under `apps/spark-tui/src/tui/`; low-level text/input/pi-tui adapters belong in `packages/spark-tui`. `apps/spark-tui/src/host/*` may keep compatibility adapters and app bootstrap/session glue.
- Daemon behavior is local-only: file queue, lock, worker loop, and `session.run` execution. Do not add gateway HTTP, token auth, remote job APIs, service install, or Pi RPC wrapping to this surface.
- Widen `spark-extension-api` only for capabilities that must be shared by both hosts.
- Add dual-host tests when changing shared extension behavior, and add Spark TUI app host tests when changing native boot, provider/model, skill, session, or TUI wiring.
