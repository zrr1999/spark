# Spark Configuration And Paths

## One Root

Spark uses one root for all user-level configuration and persistent state. The root is resolved in this order:

```text
explicit API sparkHome
> SPARK_HOME
> $HOME/.spark
```

`SPARK_HOME` is the only environment variable that relocates Spark-owned paths:

```sh
export SPARK_HOME=/path/to/spark-home
```

When it is unset, the same layout lives under `$HOME/.spark`. `SPARK_HOME` is a user-level root, not the workspace state directory.

## Layout

```text
${SPARK_HOME:-$HOME/.spark}/
├── config.json                    # Spark TUI/provider configuration
├── auth.json                      # provider credentials
├── sessions/                      # local TUI transcripts
├── ask.json                       # ask capability settings
├── agent/keybindings.json         # TUI keybinding overrides
├── role-model-settings.json       # Spark user role-to-model bindings
├── workflows/                     # user workflows
├── skills/                        # user Spark skills
├── prompts/                       # user prompt templates
├── themes/                        # user themes
├── learnings/                     # user learning artifacts
├── memory/memory.json             # user Spark memory
├── recall-candidates.json         # user recall candidates
├── exports/                       # transcript exports
├── share/                         # shareable transcript exports
├── cursor-sdk-model-list.json     # Cursor model discovery cache
├── cache/cued-version.json        # cue-shell release discovery cache
├── workspaces/<id>/               # workspace-scoped channel settings
└── apps/
    ├── cockpit/{data,cache,state,run}/
    └── daemon/{data,cache,state,run}/
```

Workspace state remains under the current workspace `.spark/`. Cross-harness role and skill definitions remain in `$HOME/.agents/{roles,skills}` and project `.agents/{roles,skills}`. Spark discovers those public layers in addition to Spark-specific `$SPARK_HOME/skills`; only Spark-owned settings and data use the unified root.

## Precedence

Explicit API path overrides are available for embedded hosts and tests. For ordinary Spark processes, `SPARK_HOME` is the sole path environment variable. If it is absent, Spark uses `$HOME/.spark`.

The following legacy variables and XDG homes no longer influence current Spark path resolution:

- `PI_ROLES_HOME`
- `PI_CODING_AGENT_DIR`
- `SPARK_MEMORY_HOME`
- `SPARK_AGENT_DIR`
- `SPARK_COCKPIT_*` storage overrides
- `SPARK_DAEMON_*` storage overrides
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `XDG_RUNTIME_DIR`

## Migration

Spark does not automatically move credentials, SQLite databases, sessions, or user-authored files. Before adopting this version, inspect the old locations and deliberately copy the data that should survive:

- `~/.agents/workflows` and `~/.agents/role-model-settings.json` (public `~/.agents/{roles,skills}` remain in place)
- `${PI_CODING_AGENT_DIR}/learning` and `${PI_CODING_AGENT_DIR}/recall-candidates.json`
- `~/.pi/agent/extensions/spark-ask.json` and any Spark-managed pi-memory compatibility Markdown
- `${XDG_DATA_HOME:-~/.local/share}/spark/`
- `${XDG_CONFIG_HOME:-~/.config}/spark/`
- `${XDG_CACHE_HOME:-~/.cache}/spark/`
- `${XDG_STATE_HOME:-~/.local/state}/spark/`
- paths selected by the retired component-specific variables listed above

Use `spark paths --json` to determine the destination tree. Stop Spark daemon and Cockpit before copying mutable databases or runtime state.

## Inspecting Paths

```sh
spark paths
spark paths --json
```

The command is read-only and reports the effective user, Cockpit, and daemon paths. It does not create directories or migrate files.
