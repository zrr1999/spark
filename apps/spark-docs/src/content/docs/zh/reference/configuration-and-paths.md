---
title: 配置与路径
description: 查看 Spark 配置、凭据、运行状态和 workspace 自有文件。
---

不要根据旧安装推断当前路径，应直接询问分发器：

```bash
spark paths
spark paths --json
```

这些命令只检查有效路径，不会创建文件。

## 自包含的 SPARK_HOME

需要一个显式根目录时设置 `SPARK_HOME`：

```bash
export SPARK_HOME=/path/to/spark-home
```

该根目录中的重要路径包括：

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

`auth.json` 包含 provider 凭据。不要提交它，也不要把它复制到 workspace 中。

## XDG 默认值

没有设置 `SPARK_HOME` 时，Spark 使用平台的 XDG 配置、数据、缓存、状态和运行根目录：

```text
$XDG_CONFIG_HOME/spark
$XDG_DATA_HOME/spark
$XDG_CACHE_HOME/spark
$XDG_STATE_HOME/spark
$XDG_RUNTIME_DIR/spark
```

某个 XDG 变量没有设置时使用对应的平台默认值。

## Managed installation 路径

Managed installation 使用 XDG data、configuration、state 与 cache 根目录，
不与 `SPARK_HOME` 混为同一状态所有者：

```text
$XDG_DATA_HOME/spark/versions/<version>/
$XDG_DATA_HOME/spark/versions/current
$XDG_CONFIG_HOME/spark/update.toml
$XDG_STATE_HOME/spark/update/
$XDG_CACHE_HOME/spark/update/
```

可用 `SPARK_UPDATE_POLICY` 与 `SPARK_UPDATE_CHANNEL` 临时覆盖策略。运行
`spark update status --json` 查看有效策略与 transaction 状态。

## Workspace 与 agent 定义

- `.spark/` 保存 workspace 自有的 Spark 运行状态。
- `~/.agents/{roles,skills,workflows}` 保存用户级可复用定义。
- `.agents/{roles,skills,workflows}` 保存项目级定义。
- `.spark/skills` 保存 workspace 专用的 Spark skills。

不存在 `$SPARK_HOME/skills` 或 `$SPARK_HOME/workflows` 目录。
