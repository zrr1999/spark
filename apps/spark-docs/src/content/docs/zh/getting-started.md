---
title: 快速开始
description: 安装 Spark、配置模型，并完成第一次前台或交互运行。
sidebar:
  order: 2
---

## 环境要求

Spark 当前要求 Node.js `>=26 <27`。公开产品同时包含 CLI 分发器、原生 TUI、
daemon 与 Cockpit host。

## 安装

推荐使用 managed installation，以获得原子升级与回滚能力：

```bash
pnpm dlx @zendev-lab/spark install --managed
spark version --json
spark update status --json
```

也可以继续由 package manager 管理安装：

```bash
npm install --global @zendev-lab/spark
spark --help
```

由 package manager 管理的安装和源码 checkout 只报告升级命令，不会替换自身。

在排查某个界面前，先运行健康检查：

```bash
spark doctor
```

## 配置模型

打开交互式 TUI：

```bash
spark
```

使用 `/login` 查看可用 provider 的认证状态并启动交互式登录流程，使用 `/model`
查看或选择当前模型。Spark 请求 API key 时应在提示框中输入；不要把密钥写进项目文件、
`config.json` 或 shell 历史。

## 完成第一次运行

需要前台、非交互式结果时：

```bash
spark run "总结这个仓库，并找出它的验证命令。"
```

脚本集成使用 JSON 模式：

```bash
spark run --json "列出顶层 packages。"
```

需要交互式会话时，可以停留在 `spark` 中，或运行：

```bash
spark tui "在提出修改前先检查当前项目。"
```

Spark 会按需启动或连接本地 daemon。应使用 `spark daemon status --json`
检查服务状态，不要从前端表现猜测 daemon 是否健康。

## 下一步

- 了解[每个界面拥有什么行为](/zh/concepts/surfaces/)。
- 在[前台运行、后台工作和会话](/zh/guides/runs-and-sessions/)之间选择。
- 打开 [Cockpit Web 界面](/zh/guides/cockpit/)。
