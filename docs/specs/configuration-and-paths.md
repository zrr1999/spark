# Spark Configuration And Paths

## Path roots

Spark uses `SPARK_HOME` as an explicit all-in-one root when it is set. When it is unset, Spark follows the XDG directories independently:

```text
explicit API sparkHome > SPARK_HOME > XDG roots
```

The XDG roots are:

```text
XDG_CONFIG_HOME                         default $HOME/.config
XDG_DATA_HOME                           default $HOME/.local/share
XDG_CACHE_HOME                          default $HOME/.cache
XDG_STATE_HOME                          default $HOME/.local/state
XDG_RUNTIME_DIR                         app runtime falls back to XDG state
```

Set one explicit root when a self-contained installation is preferred:

```sh
export SPARK_HOME=/path/to/spark-home
```

`SPARK_HOME` is a user-level root, not the workspace state directory.

## Layout

With `SPARK_HOME` set:

```text
$SPARK_HOME/
├── config.json                    # Spark TUI/provider configuration
├── auth.json                      # provider credentials
├── sessions/                      # local TUI transcripts
├── ask.json                       # ask capability settings
├── agent/keybindings.json         # TUI keybinding overrides
├── role-model-settings.json       # Spark user role-to-model bindings
├── prompts/                       # user prompt templates
├── themes/                        # user themes
├── memory/
│   ├── memory.json                # user Spark memory
│   ├── learnings/                 # user learning artifacts
│   └── recall-candidates.json     # user recall candidates
├── exports/                       # transcript exports
├── share/                         # shareable transcript exports
├── cursor-sdk-model-list.json     # Cursor model discovery cache
├── cache/cued-version.json        # cue-shell release discovery cache
├── workspaces/<id>/               # workspace-scoped channel settings
└── apps/
    ├── cockpit/{data,cache,state,run}/
    └── daemon/{data,cache,state,run}/
```

With `SPARK_HOME` unset, files are split by XDG ownership:

```text
$XDG_CONFIG_HOME/spark/        config, auth, ask, role model settings, prompts, themes, keybindings, app TOML files
$XDG_DATA_HOME/spark/          sessions, memory/, exports, share, workspaces, cockpit/, daemon/
$XDG_CACHE_HOME/spark/         model/release caches, cockpit/, daemon/
$XDG_STATE_HOME/spark/         cockpit/, daemon/ state and logs
$XDG_RUNTIME_DIR/spark/        cockpit/, daemon/ sockets and pid files (app state `run/` fallback)
```

The namespace is added after the XDG root, so the default config path is `$HOME/.config/spark/config.json`, not `$HOME/.config/config.json`. If `XDG_RUNTIME_DIR` is unset, each app uses `$XDG_STATE_HOME/spark/<app>/run`.

## Public agent definitions

User role, skill, and workflow definitions use the public cross-harness standard and are independent of `SPARK_HOME` and XDG:

```text
$HOME/.agents/roles/
$HOME/.agents/skills/
$HOME/.agents/workflows/
```

There is no `$SPARK_HOME/skills` or `$SPARK_HOME/workflows`. Project role, skill, and workflow definitions remain under project `.agents/{roles,skills,workflows}`; Spark retains only a workspace-specific `.spark/skills` definition layer. `.spark/workflows` is retired and is not discovered; move existing saved scripts to `.agents/workflows`. Workspace-owned Spark state remains under the workspace `.spark/`. Memory-related workspace state lives under `.spark/memory/`:

```text
.spark/memory/
├── memory.json
├── learnings/                 # replaces repository-root .learnings/
├── recall-candidates.json     # replaces .spark/recall-candidates.json
└── reflections/               # replaces .spark/reflections/
```

## Retired variables

These variables have no current path-resolution implementation and are ignored:

- `PI_ROLES_HOME`
- `PI_CODING_AGENT_DIR`
- `PI_MEMORY_DIR`
- `SPARK_MEMORY_HOME`
- `SPARK_MEMORY_COMPAT_DIR`
- `SPARK_AGENT_DIR`
- `SPARK_COCKPIT_*_DIR`
- `SPARK_DAEMON_*_DIR`

Explicit API path overrides remain available for embedded hosts and tests.

## Migration

Spark does **not** automatically move credentials, SQLite databases, sessions, or unrelated user-authored files. Stop Spark daemon and Cockpit before copying mutable databases or runtime state.

Serialized marker names and paths under `.spark/` are public persistence contracts. Change them only through an explicit, idempotent migration with compatibility tests; a package or command rename alone must not rewrite persisted markers.

Memory-related layout migration **is** automatic and idempotent via `migrateSparkMemoryLayout` (triggered on memory `session_start` and memory tool access):

| Old path | New path |
|----------|----------|
| `$dataRoot/learnings/` | `$dataRoot/memory/learnings/` |
| `$dataRoot/recall-candidates.json` | `$dataRoot/memory/recall-candidates.json` |
| `.learnings/` (workspace/repo) | `.spark/memory/learnings/` |
| `.spark/recall-candidates.json` | `.spark/memory/recall-candidates.json` |
| `.spark/reflections/` | `.spark/memory/reflections/` |

Rename is preferred; cross-device moves fall back to copy+verify. If the target already exists and is non-empty, Spark merges directories or skips conflicting files and records the outcome.

Public `$HOME/.agents/{roles,skills,workflows}` definitions should remain in place. Old component variables and Pi-specific locations may still identify migration sources, but they do not affect current path resolution.

pi-memory Markdown import remains explicit: `memory({ action: "import_legacy", apply: false })` then `apply: true` after review.

## Inspecting paths

```sh
spark paths
spark paths --json
```

The command is read-only and reports effective user, Cockpit, and daemon paths. It does not create directories or migrate files.
