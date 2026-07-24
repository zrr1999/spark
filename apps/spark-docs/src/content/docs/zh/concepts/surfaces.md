---
title: 界面与所有权
description: 理解 CLI 分发器、TUI、daemon 与 Cockpit，避免产生相互竞争的真相来源。
---

Spark 提供的是同一个系统的多个视图，而不是多个可以互换的执行器。

| 界面 | 用途 | 所有权 |
| --- | --- | --- |
| `spark` CLI | 稳定的公开命令路由 | 只负责分发 |
| TUI | 交互式 prompt、本地编辑器行为、会话 attach | 终端展示和 host-local 交互 |
| Daemon | 持久会话、invocation、本地 RPC、channel、恢复 | 执行真相与持久本地运行状态 |
| Cockpit | 浏览器控制、投影、跨 daemon 协调 | Web 展示与 Cockpit 自有协调状态 |
| Updater | managed install、升级策略、原子切换、回滚 | 已安装版本与升级 transaction 状态 |

## 唯一执行所有者

前台 `spark run`、后台 `spark bg`、TUI prompt 和 Cockpit 提交最终都使用
daemon 拥有的执行路径。某个前端断开不会把 invocation 的所有权转移给另一个前端。

Updater 是独立的状态所有者，不是另一个执行器。只有在 updater 完成版本切换后，
daemon 才参与带健康检查与目标 fence 的 handoff。

排查状态不一致时，先检查 daemon：

```bash
spark daemon status --json
spark daemon session list --json
```

## Workspace 绑定

会话与 canonical workspace 绑定。请从目标 workspace 运行命令，不要 attach
由另一个 canonical 工作目录创建的会话。

Workspace 内的 Spark 状态位于 `.spark/`。用户配置和服务状态在显式设置时使用
`SPARK_HOME`，否则使用标准 XDG 根目录。详情见[配置与路径](/zh/reference/configuration-and-paths/)。

## 产品边界

`@zendev-lab/spark` 是唯一公开 npm 产品。源码仓库中的 workspace packages
是实现边界，不是独立支持的安装目标。
