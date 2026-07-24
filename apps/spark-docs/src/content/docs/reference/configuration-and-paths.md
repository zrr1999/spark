---
title: Configuration and paths
description: Inspect Spark configuration, credentials, runtime state, and workspace-owned files.
---

Never infer an active path from an old installation. Ask the dispatcher:

```bash
spark paths
spark paths --json
```

These commands inspect effective paths without creating files.

## Self-contained SPARK_HOME

Set `SPARK_HOME` when you want one explicit root:

```bash
export SPARK_HOME=/path/to/spark-home
```

Important paths under that root include:

```text
$SPARK_HOME/config.json
$SPARK_HOME/auth.json
$SPARK_HOME/sessions/
$SPARK_HOME/agent/
$SPARK_HOME/prompts/
$SPARK_HOME/themes/
$SPARK_HOME/apps/daemon/{data,cache,state,run}
$SPARK_HOME/apps/cockpit/{data,cache,state,run}
```

`auth.json` contains provider credentials. Do not commit or copy it into a
workspace.

## XDG defaults

Without `SPARK_HOME`, Spark uses the platform's XDG configuration, data, cache,
state, and runtime roots:

```text
$XDG_CONFIG_HOME/spark
$XDG_DATA_HOME/spark
$XDG_CACHE_HOME/spark
$XDG_STATE_HOME/spark
$XDG_RUNTIME_DIR/spark
```

Platform defaults apply when an individual XDG variable is unset.

## Managed installation paths

A managed installation uses the XDG data, configuration, state, and cache
roots independently of `SPARK_HOME`:

```text
$XDG_DATA_HOME/spark/versions/<version>/
$XDG_DATA_HOME/spark/versions/current
$XDG_CONFIG_HOME/spark/update.toml
$XDG_STATE_HOME/spark/update/
$XDG_CACHE_HOME/spark/update/
```

Use `SPARK_UPDATE_POLICY` and `SPARK_UPDATE_CHANNEL` for temporary policy
overrides. Run `spark update status --json` to inspect the effective policy and
transaction state.

## Workspace and agent definitions

- `.spark/` contains workspace-owned Spark runtime state.
- `~/.agents/{roles,skills,workflows}` contains user-level reusable definitions.
- `.agents/{roles,skills,workflows}` contains project-level definitions.
- `.spark/skills` contains workspace-specific Spark skills.

There are no `$SPARK_HOME/skills` or `$SPARK_HOME/workflows` directories.
