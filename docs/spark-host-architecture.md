# Spark host architecture

Spark has two host targets that share extension packages through `pi-extension-api`.

## Data flow

```text
                     ┌──────────────────────────────┐
                     │  Pi host                      │
                     │  @earendil-works/pi-coding-  │
                     │  agent extension runtime      │
                     └──────────────┬───────────────┘
                                    │ pi-extension-api
                                    │
┌───────────────────────────────────▼───────────────────────────────────┐
│ Shared retained extension packages                                      │
│                                                                         │
│  pi-ask        pi-cue        pi-roles        pi-graft        spark-ext   │
│  ask tools     cue tools     role tools      graft tools     modes +     │
│                                                           Spark tools    │
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
│ pi-tui      │              │ pi-ai       │              │ SparkHost-  │
│ ProcessTerm │ user input   │ stream via  │ tool calls   │ Runtime     │
│ TUI Editor  │─────────────▶│ active      │─────────────▶│ tools,      │
│ transcript  │◀────────────│ provider    │◀────────────│ commands,   │
└─────────────┘ assistant    └─────────────┘ tool result  │ events, UI  │
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
- Constructs `SparkHostRuntime` and native host services in `src/host/bootstrap.ts`.
- Loads retained builtin extensions through explicit imports in `SparkExtensionLoader`; it does not call Pi SDK discovery or `loadPiSdk`. The default builtin set is `@zendev-lab/pi-ask`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-files`, `@zendev-lab/pi-roles`, `@zendev-lab/pi-graft`, and `@zendev-lab/spark-extension`.
- Registers working-tree file tools (`read`/`write`/`edit`/`ls`/`grep`/`find`) natively through the `@zendev-lab/pi-files` extension. `cue_exec` remains the shell surface; there is no `bash` tool (pi-cue disables bash by policy).
- Registers providers through `SparkProviderRegistry` and runs turns through `SparkAgentLoop` / `SparkAgentSession` on top of `@earendil-works/pi-ai`.
- Owns terminal UI components through the `@zendev-lab/spark-tui` boundary and app-local `pi-tui` adapter.
- Stores native sessions as Pi-compatible JSONL v3 files under `~/.spark/sessions/<workspaceHash>/`.
- Owns a local daemon-only queue under `~/.spark/daemon/` plus `~/.spark/runtime/daemon.lock` for detached `session.run` execution.
- Resolves workspace and user skills from `<cwd>/.spark/skills/**` and `~/.spark/skills/**`. Resolves prompt templates from `<cwd>/.spark/prompts/*.md`, `~/.spark/prompts/*.md`, and configured `promptTemplates` paths, then registers non-colliding templates as native slash commands. The Spark product no longer bundles project-idea/SPARK.md workflow prompts under `packages/spark-extension/skills/**`; those live in external skill repositories such as `zrr1999/skills`.

## Boundary rules

- Shared extension packages should import types from `pi-extension-api`, not runtime values from `@earendil-works/pi-coding-agent` or Spark app packages.
- Native host-only behavior belongs under `apps/spark-tui/src/host/`; app-level TUI wrappers belong under `apps/spark-tui/src/tui/`; low-level text/input/pi-tui adapters belong in `packages/spark-tui`.
- Daemon behavior is local-only: file queue, lock, worker loop, and `session.run` execution. Do not add gateway HTTP, token auth, remote job APIs, service install, or Pi RPC wrapping to this surface.
- Widen `pi-extension-api` only for capabilities that must be shared by both hosts.
- Add dual-host tests when changing shared extension behavior, and add Spark TUI app host tests when changing native boot, provider/model, skill, session, or TUI wiring.
