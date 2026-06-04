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
│  pi-ask        pi-cue        pi-roles        pi-graft        spark       │
│  ask tools     cue tools     role tools      graft tools     /spark +    │
│                                                           Spark tools    │
└───────────────────────────────────▲───────────────────────────────────┘
                                    │ explicit factories
                                    │
                     ┌──────────────┴───────────────┐
                     │  Spark CLI native host        │
                     │  packages/spark-cli           │
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

### Spark CLI native host

- Starts with `packages/spark-cli/bin/spark` and `src/cli.ts`.
- Constructs `SparkHostRuntime` and native host services in `src/host/bootstrap.ts`.
- Loads retained builtin extensions through explicit imports in `SparkExtensionLoader`; it does not call Pi SDK discovery or `loadPiSdk`.
- Registers providers through `SparkProviderRegistry` and runs turns through `SparkAgentLoop` / `SparkAgentSession` on top of `@earendil-works/pi-ai`.
- Owns terminal UI components through `@earendil-works/pi-tui`.
- Stores native sessions as Pi-compatible JSONL v3 files under `~/.spark/sessions/<workspaceHash>/`.
- Owns a local daemon-only queue under `~/.spark/daemon/` plus `~/.spark/runtime/daemon.lock` for detached `session.run` execution.
- Resolves skills from builtin, workspace, and user layers: `packages/spark/skills/**`, `<cwd>/.spark/skills/**`, and `~/.spark/skills/**`.

## Boundary rules

- Shared extension packages should import types from `pi-extension-api`, not runtime values from `@earendil-works/pi-coding-agent` or `spark-cli`.
- Native host-only behavior belongs under `packages/spark-cli/src/host/`; pi-tui wrappers belong under `packages/spark-cli/src/tui/`.
- Daemon behavior is local-only: file queue, lock, worker loop, and `session.run` execution. Do not add gateway HTTP, token auth, remote job APIs, service install, or Pi RPC wrapping to this surface.
- Widen `pi-extension-api` only for capabilities that must be shared by both hosts.
- Add dual-host tests when changing shared extension behavior, and add `spark-cli` host tests when changing native boot, provider/model, skill, session, or TUI wiring.
