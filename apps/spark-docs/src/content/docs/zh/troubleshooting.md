---
title: 故障排查
description: 按正确顺序诊断 TUI、daemon、会话、路径和 Cockpit 故障。
---

## TUI 提示需要交互式终端

`spark` 和 `spark tui` 要求 stdin 与 stdout 都是 TTY。脚本或重定向输出应使用
headless 界面：

```bash
spark run --json "检查这个仓库。"
```

## 运行或 Cockpit 页面看起来卡住

分别检查前端健康和 daemon 执行：

```bash
spark doctor
spark daemon status --json
spark daemon logs --lines 200
```

如果已经有 invocation identifier，应检查它的状态与事件流，不要再次提交相同工作。

## 无法 attach 会话

会话与 workspace 绑定。切换到创建会话时使用的同一个 canonical workspace 后重试：

```bash
spark daemon session list --json
spark tui --session-id <session-id>
```

## Spark 读取了意外的配置

检查当前有效根目录：

```bash
spark paths --json
```

检查是否有意设置了 `SPARK_HOME` 和相关 XDG 变量。不要把复制凭据或状态作为第一修复手段。

## Managed update 失败

重试前先检查持久化的 updater 状态：

```bash
spark update status --json
```

失败的 candidate 会被 quarantine，不会自动重复尝试。只有修复报告的问题后，才使用
`spark update retry <version> --yes`。回滚只切换 executable 版本，不会恢复旧数据库
快照，也不会丢弃会话。

## Cockpit 返回错误或没有 workspace

先确认 Cockpit 本身正在运行，再分别检查 daemon 健康、workspace registration
以及 daemon 使用的 URL：

```bash
spark daemon status --json
spark daemon workspace ls --json
```

远程访问需要分别确认 HTTPS、机器登录、workspace registration 与浏览器 key scope。

## 重试失败的外部投递之前

不要假设超时代表没有发送。外部投递结果不确定时，Spark 会 fail closed。
只有记录结果证明没有发送，或 provider 提供可去重 identity 时，才应重试。
