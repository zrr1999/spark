---
title: CLI 参考
description: 稳定的公开 Spark 分发命令，以及常用 daemon 和 Cockpit 操作。
---

## 分发器

```text
spark
spark run [--json] [--wait] [--resume <session>] <prompt>
spark bg [--session <id>] [--json] <prompt>
spark paths [--json]
spark doctor
spark tui [initial message]
spark install --managed [--version <version>] [--prefix <path>]
spark update status|check|apply|rollback|retry|configure
spark version [--json]
spark daemon <command> [args...]
spark cockpit [command] [args...]
spark --help
spark --version
```

- `spark` 打开交互式 TUI。
- `spark run` 执行前台 headless 运行。
- `spark bg` 提交持久后台工作。
- `spark paths` 报告有效的配置与状态路径。
- `spark doctor` 通过 daemon CLI 运行顶层健康诊断。
- `spark install --managed` 创建带不变 launcher 的 managed installation。
- `spark update` 拥有升级策略、版本切换与回滚。
- `spark version` 报告精确的 package 与 build identity。
- `spark daemon` 操作 execution-plane 资源。
- `spark cockpit` 启动或管理 Web coordination 界面。

未知子命令会失败，不会被解释为 prompt。

## Managed installation 与升级

```text
spark install --managed [--version <version>] [--prefix <path>]
spark update status [--json]
spark update check [--json]
spark update configure --policy manual|notify|auto --channel latest|next
spark update apply [version] --yes
spark update rollback --yes
spark update retry [version] --yes
spark version [--json]
```

`apply`、`rollback` 与 `retry` 会修改 managed installation，因此要求
`--yes`。默认策略为 `notify`，自动应用仍需显式启用。Updater 永远不会修改
package-manager installation 或源码 checkout。

## Daemon 服务

```text
spark daemon status [--json]
spark daemon start
spark daemon stop
spark daemon restart [--yes] [--wait]
spark daemon sync [--wait]
spark daemon logs [--follow] [--lines <n>]
```

## 会话与 invocation

```text
spark daemon session list --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

## Workspace 与远程 Cockpit

```text
spark daemon login --server-url <url>
spark daemon workspace register . --server-url <url> --token <token> --name <name>
spark daemon workspace ls --json
spark cockpit access create
spark cockpit workspace access create --workspace <id>
```

只应在明确受信任的私有网络中使用 `--allow-insecure-http`。所有非 loopback
Cockpit URL 都应优先使用 HTTPS。
