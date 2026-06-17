---
description: "spark：面向 Pi 的 Spark 工作流套件"
owner: zrr1999
created: 2026-05-18
updated: 2026-06-15
inspired_by:
   - pi
   - cue-shell
   - pi-ask
   - pi-roles
---

# `spark` 项目意图

## 起源

`spark` 是面向 Pi 的 Spark 工作流套件。它通过意图明确的用户命令与规范化工具，将项目意图、项目与任务有向无环图、结构化提问、审查、证据制品、角色执行以及 `cue-shell` 执行能力组织为可追溯的本地工作流。早期 `SPARK.md` 由占位意图生成；当前文件依据已经落地的包边界、历史任务审查和实现状态重新整理。

## 当前工作标题

- Spark 工作流套件
- 面向 Pi 的本地智能开发编排

## 目标

- 让 Spark 在没有 `.spark/` 或 `SPARK.md` 预置状态时也能默认进行轻量调查，并让 project-bound 命令在需要项目绑定状态时从用户意图创建或恢复本地 Spark 状态，而不是依赖聊天上下文记忆。
- 用持久化的项目与任务有向无环图表达工作分解、依赖、认领、待办事项、运行记录和完成状态。
- 用类型化证据制品记录结构化提问答案、角色执行输出、审查结果、运行轨迹和后续证据。
- 将结构化提问作为工作流原语：在项目、任务、路线图或审查流程需要真实澄清或决策时调用，而不是展示宽泛的录入表单。
- 将可复用角色定义和单次子 Pi 执行下沉到 `pi-roles`；Spark 仅负责有向无环图、任务、证据制品、审查和结构化提问的编排。
- 将 `cue-shell` 执行能力作为 `pi-cue` 的可复用底座；默认输出应适合上下文阅读，并保留按需展开完整输出的方式。
- 将任务计划、就绪性和证据要求作为完成状态约束，避免失败、未启动或空输出的运行被误判为完成。

## 当前包边界

Spark 现在支持两个宿主目标：Pi 中的 `packages/spark/src/extension/` 是意图命令和门面策略的 Pi 扩展入口；`packages/spark-cli` 是原生 `pi-tui` 宿主，负责构造 `SparkHostRuntime`、显式内置扩展加载器、提供方注册表、模型选择器、JSONL 会话存储、三层技能解析器和 `SparkAgentLoop`。共享扩展包通过 `pi-extension-api` 在两个宿主中运行，不应依赖具体的 Pi SDK 运行时。

- `packages/spark`：Pi 扩展门面、默认轻量 research 行为、`/plan`、`/implement`、`/goal`、`/loop`、`/workflow`、Spark 小组件、模式与策略、内置 Spark 角色以及活动上下文提供方。
- `packages/spark-runtime`：单个 Spark 任务到角色执行的适配层，负责调用 `pi-roles` 并回写证据制品、运行记录和状态。
- `packages/pi-extension-api`：共享扩展宿主与工具契约、引用、错误类型以及轻量 JSON、文件系统和时间辅助能力。
- `packages/pi-artifacts`：证据制品元数据与二进制对象存储、来源、谱系，以及规范化 `artifact({ action })` 工具。
- `packages/pi-tasks`：通用项目、任务、待办事项与运行图；负责依赖、认领租约、任务计划就绪性、任务状态、运行状态以及规范化 `task({ action })` 工具。
- `packages/pi-learnings`：基于证据的可复用经验存储、`.learnings/` 本地与用户作用域、导出导入、生命周期管理以及规范化 `learning({ action })` 工具。
- `packages/pi-goal`：通用目标状态和延续提示原语；Spark 只保留项目绑定的 `/goal` 门面，历史序列化标记保持兼容。
- `packages/pi-workflows`：已保存工作流的发现与运行时原语，以及 `.spark/workflow-runs.json` 工作流运行存储。
- `packages/pi-ask`：通用规范化 `ask({ action })` 协议、内部聚焦与全屏流程状态机、TUI 渲染和结果语义；具体问题由调用处根据实际上下文生成，不提供制式表单。
- `packages/pi-roles`：`RoleSpec`、项目/用户/内置角色存储、`RoleRun` 全新或分叉子 Pi 执行，以及角色工具；不拥有任务有向无环图。
- `packages/pi-cue`：`cue-shell` IPC 与工具适配层；不依赖 Spark 状态。
- `packages/pi-context`：有界注册上下文提供方。
- `packages/pi-recall`：显式作用域的召回候选，与 `.learnings/` 在语义上相互独立。
- `packages/spark-cli`：以 Spark 为中心的原生 TUI 宿主；宿主专用代码位于 `src/host/`，`pi-tui` 包装位于 `src/tui/`，不嵌入 `@earendil-works/pi-coding-agent`。

已退场的工作区包包括 `spark-core`、`spark-tasks`、`spark-learnings`、`spark-goal` 和 `spark-workflows`。`pi-* -> spark-*` 反向依赖由 `pnpm run check:boundaries`、`prek` 和 CI 静态检查守门。`.spark/` 目录、`.spark/projects.json`、`.spark/workflow-runs.json` 和历史目标标记属于磁盘格式兼容数据，不因包名迁移而改名。

## 非目标

- 不将本仓库泛化为公开模板或通用项目管理产品。
- 不复制 OpenSpec/OpenArc 的完整文件树、变更目录或重型流程。
- 不在 `pi-roles` 中引入 Spark 有向无环图、任务认领、证据制品或调度器语义。
- 不保留旧 `spark-agents` / `pi-agent-run` 公开兼容包；只对必要的历史持久化状态保留窄读兼容。
- 不保留长期 `spark_*` 工具别名或双重公开/默认工具表面；外部工具表面使用规范化 `task_read`、`task_write`、`assign`、`learning`、`artifact`、`ask`、`goal` 等工具，动作工具渲染为 `tool action=<value> ...`。
- 不让结构化提问成为用户必须直接操作的独立产品面；它应服务具体的项目、任务、路线图或审查流程。
- 不默认隐藏或丢弃执行证据；输出可以精简，但完整证据应能通过证据制品、完整读取或尾部读取参数取回。

## 成功信号

- Project-bound 命令初始化或恢复不会覆盖既有状态，不会生成占位任务，也不会要求用户先填写宽泛表单。
- `task_read({ action: "status" })` 和 Spark 小组件能以低噪声方式展示当前项目、活动任务、待办事项、工作流运行状态和就绪性问题。
- `task_write({ action: "plan" })`、`task_write({ action: "claim" })` 和 `assign({ dryRun: true })` 能区分规划、认领、实现和完成；角色执行失败或未启动不会被错误标记为任务完成。
- `ask({ action: "ask" | "flow" })` 的聚焦与全屏流程结果语义一致：自定义输入是一等结果，决策或审批没有有效选项时会阻塞，用户界面不泄漏原始标识符。
- `pi-roles` 角色规范与运行工具同 Spark 工作流运行边界清晰，直接 `role({ action: "call" })` 不冒充任务执行。
- `pi-cue` 工具默认输出有界且适合上下文阅读，同时保留获取完整输出的显式方式。
- 关键行为有测试、类型检查和 `vp check` 覆盖，并通过 `prek` 或 CI 验证。

## 当前开放问题

- 路线图已经作为每个项目内嵌的唯一规划层落在 `projects.json`；后续是否抽成独立 `pi-planning` 能力仍待观察。
- 完成证据门禁应严格到什么程度：对人工任务、审查/设计任务和角色执行/工作流任务是否采用不同要求。
- 历史任务中被完成摘要覆盖的原始意图是否需要进一步从聊天记录、每日记忆或 Git 历史中恢复。

## 近期收尾任务

- 完成当前包边界迁移后的最终文档同步。
- 后续可单独拆分仍偏大的实现文件，例如部分任务或运行时内部模块；该拆分不阻塞当前边界迁移。

## 修订记录

- 2026-05-18：早期由兼容入口初始生成占位项目意图。
- 2026-05-22：根据历史任务审查、`pi-roles` 迁移、结构化提问、任务和 `cue` 边界，以及当时实现状态重建项目意图。
- 2026-06-05：根据门面切换、实现下沉和 `spark-core`、`spark-tasks`、`spark-learnings`、`spark-goal`、`spark-workflows` 退场更新当前边界。
- 2026-06-15：统一正式中文表述，保留必要代码标识符和兼容性术语。
- 2026-06-16：更新默认研究模式、`/implement` 模式命名以及 Spark 组合 Pi 扩展能力的边界表述。
