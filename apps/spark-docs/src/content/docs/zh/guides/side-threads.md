---
title: Side Threads
description: 在只读的旁支会话中提问，并有意识地把有用上下文交回主会话。
---

Side Threads 是由 daemon 拥有、附属于主 TUI 会话的只读子对话。
它适合调查旁支问题，同时避免污染主对话。

## 基本流程

在原生 TUI 中运行：

```text
/btw show
/btw ask 这个模块对 retry 有哪些假设？
/btw handoff summary 把 retry 结论加入主会话上下文。
```

`show` 会创建或复用子会话，并显示它的 generation、状态、模型、thinking level、
待处理工作和最近可见 exchange。

## 重置与配置

```text
/btw reset contextual
/btw reset tangent
/btw model inherit
/btw thinking high
```

重置会开始新的 Side Thread generation。模型和 thinking override 只影响子会话。

## 只读边界

Side Threads 只能使用只读 tool effect。写入、命令执行、策略变更和外部副作用会被
host 拒绝。回答可以建议修改，但不能声称已经执行了修改。

`handoff full` 或 `handoff summary` 会把选定结果显式接纳到主会话，并在接纳后
重置子会话。只有当旁支结论确实属于主线时才进行 handoff。
