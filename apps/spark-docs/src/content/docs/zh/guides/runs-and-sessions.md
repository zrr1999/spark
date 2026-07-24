---
title: 运行与会话
description: 在前台、后台、交互式与恢复执行之间选择。
---

## 前台 headless 工作

`spark run` 会等待 headless 运行结束并打印结果：

```bash
spark run "审查当前 diff。"
spark run --json "返回机器可读的仓库摘要。"
```

需要延续上下文时，恢复一个已知会话：

```bash
spark run --resume <session-id> "继续下一个经过验证的步骤。"
```

## 后台工作

`spark bg` 向 daemon 提交 invocation 并返回 receipt。没有显式会话时，
Spark 会创建 invocation session 标识：

```bash
spark bg --json "运行仓库验证并报告失败项。"
```

向现有会话继续提交工作：

```bash
spark bg --session <session-id> "只重新运行失败的检查。"
```

使用 daemon 命令检查 invocation，不要启动另一个执行器：

```bash
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason "不再需要" --json
```

## 交互式会话

列出 daemon 会话，并从同一个 workspace attach：

```bash
spark daemon session list --json
spark tui --session-id <session-id>
```

会话标识会保留对话与执行连续性，但不会绕过 workspace 绑定或权限检查。

## 应该使用哪一种？

- 只要一个前台结果时使用 `spark run`。
- 希望 shell 在持久提交后立即返回时使用 `spark bg`。
- 需要交互探索与 steering 时使用 `spark` 或 `spark tui`。
- 需要从浏览器观察和控制现有 daemon 工作时使用 Cockpit。
