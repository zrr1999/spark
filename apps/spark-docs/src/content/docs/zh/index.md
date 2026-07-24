---
title: Spark 文档
description: 面向 Spark CLI、TUI、daemon 与 Cockpit 的用户文档。
template: splash
hero:
  tagline: 在前台运行 coding agent，把持久工作交给 daemon，并从终端或 Cockpit 进行监督。
  actions:
    - text: 快速开始
      link: /zh/getting-started/
      icon: right-arrow
    - text: CLI 参考
      link: /zh/reference/cli/
      icon: right-arrow
      variant: minimal
sidebar:
  order: 1
---

Spark 是一套受控的 coding-agent 工具，只有一个公开的 `spark` 命令和三个产品界面：

- 用于交互工作的 **TUI**，
- 负责持久会话与后台 invocation 的 **daemon**，
- 用于 Web 控制与投影的 **Cockpit**。

可以先阅读[安装与首次运行](/zh/getting-started/)。在自动化 Spark 或进行远程运维前，
请先理解[界面与所有权](/zh/concepts/surfaces/)。

## 本文档覆盖什么

- 安装公开发布的 npm 产品，
- 选择前台、后台、TUI 或 Cockpit 工作方式，
- 恢复与 workspace 绑定的会话，
- 查看配置与状态路径，
- 排查常见的本地和远程访问故障。

实现仓库始终是真相来源。本站的用户命令示例会与源码中的 `spark --help` 分发器进行校验。
