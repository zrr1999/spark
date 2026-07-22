---
description: "spark：以 Pi SDK 为内核，统一 TUI / Cockpit / 消息平台的本地智能开发编排"
owner: zrr1999
created: 2026-05-18
updated: 2026-07-22
inspired_by:
  - pi-sdk
  - cue-shell
  - spark-ask
  - spark-roles
  - agetor
  - agent-orchestrator
  - agent-deck
  - coder-mux
---

# `spark` 项目意图

## 起源

`spark` 最初作为面向 Pi 产品的工作流套件起步，通过意图明确的用户命令与规范化工具，将项目意图、任务有向无环图、结构化提问、审查、证据制品、角色执行以及 `cue-shell` 执行能力组织为可追溯的本地工作流。仓库落地后，执行与会话中枢已迁移到 Spark daemon，产品面扩展为原生 TUI、Cockpit Web 与消息通道；**Pi SDK**（`@earendil-works/pi-ai`、`@earendil-works/pi-tui` 及与之对齐的流式/会话形状）仍是模型与终端呈现内核，**Pi 产品宿主**（`pi-coding-agent` 扩展加载路径）则降为待冻结的兼容面。

## 当前工作标题

- Spark 本地智能开发编排
- 统一 TUI / Cockpit / 消息平台，Pi SDK 为内核

## 目标

- 以 daemon 为持久会话与调用调度真源；TUI、Cockpit、消息通道、本地 RPC 共用一套 registry 与 invocation，不维护并行会话状态机。
- 在 `spark-protocol` 中沉淀跨表面交互协议（ask 判定、slash/action catalog、session status / pending turns、可展示错误），各表面只保留呈现与执行胶水。
- 保持 Pi SDK 为内核：模型流、provider、终端 UI 原语继续建立在 `pi-ai` / `pi-tui`（经 `spark-ai` / `spark-tui` 边界）之上，不把“退场 Pi 产品”误解为剥离 SDK。
- 冻结并规划退场 Pi 产品宿主兼容：`pi-extension`、`package.json#pi` 发现、`pi-coding-agent` 加载路径只保留窄读与必要磁盘格式兼容，新能力只进入 Spark 宿主家族。
- 将 side conversation、worktree/change/PR/CI/review feedback 与 provider runtime 建模为可组合的领域契约：产品表面消费同一状态与反馈闭环，而不是各自维护一套按钮、轮询器或终端启发式。
- 为 invocation、provider、tool、delivery 与代码交付保留隐私安全的关联观测边界；执行真相仍在 daemon/SQLite，可选 exporter 或外部观察面不得成为状态所有者。
- 将 command policy 与实际执行隔离逐步对齐，在不改变 local-first 语义的前提下，为支持平台提供显式、fail-closed 的 sandbox runner。
- 让 Spark 在没有 `.spark/` 或 `SPARK.md` 预置状态时也能默认进行轻量调查，并让 project-bound 命令在需要时从用户意图创建或恢复本地 Spark 状态。
- 用持久化的项目与任务有向无环图、类型化证据制品、结构化提问与角色执行组织可追溯工作流；`cue-shell` 能力经 `spark-cue` 复用。

## 当前包边界

- **内核（Pi SDK）**：`spark-ai`（`pi-ai`）、`spark-tui` / `spark-text`（`pi-tui`）、以及与 pi-ai 流形状对齐的 `spark-turn`。
- **执行宿主**：`spark-host` + `spark-turn` 服务 TUI / headless / daemon；`apps/spark-daemon` 拥有会话、通道与 SQLite；`apps/spark-tui` 与 `apps/spark-cockpit` 是一等产品面。
- **跨表面契约**：`spark-protocol`（含 ask 语义、action-bar、session view、human-interaction 生命周期）；`spark-core`（由 `spark-extension-api` 重命名）是 Spark 宿主契约 + 轻量 primitives（`SparkHostAPI` 类型与依赖极轻的 helpers），不是复活已退场的能力袋 `spark-core`。
- **能力包**：`spark-ask`、`spark-artifacts`、`spark-tasks`、`spark-roles`、`spark-cue`、`spark-channels`、`spark-cockpit-coordination` 等；工具表面使用规范化 `tool({ action })`。
- **Pi 产品兼容（冻结）**：`packages/pi-extension`（legacy facade，slated for retirement）、`packages/pi-btw`、以及各包上的 `"pi": { "extensions": ... }` 发现元数据。`pi-btw` 只保留 Pi 子会话与 UI 适配；共享 side-thread 状态契约进入 `spark-turn`，Spark 原生宿主通过显式 adapter 加载能力，不重新引入 Pi SDK package discovery。

已退场的工作区包包括历史能力袋 `spark-core`（与现 `@zendev-lab/spark-core` 无关）、`spark-goal`、`spark-learnings` 与 `spark-recall`。`spark-tasks`、`spark-workflows` 仍是当前包；learning / recall / reflection 由 `spark-memory` 拥有。`pi-* -> spark-*` 反向依赖由边界检查守门。`.spark/` 磁盘格式不因包名迁移而改名（reflection 落盘路径统一到 `.spark/memory/reflections/` 除外）。

## 非目标

- 不将本仓库泛化为公开模板或通用项目管理产品。
- 不剥离或重写 Pi SDK 内核去“去 Pi 化”；退场对象是 Pi **产品**宿主，不是 `pi-ai` / `pi-tui`。
- 不为 Pi 产品宿主新增一等能力；不长期保留双重公开工具表面。
- 不把 TUI 进程内 follow-up 队列与 daemon `pendingTurns` 盲目合并成单一数组；采用双层模型：daemon `pendingTurns` 是跨表面耐久真相，TUI `queuedFollowUps` 只保留未 ack 的乐观 steer/followUp（合并、编辑器恢复），ack 后以 daemon 投影为准。
- 不把 Cockpit 专用 notice/error part 未经设计提升进协议。
- 不复制 OpenSpec/OpenArc 的完整文件树或重型流程。
- 不让结构化提问成为用户必须直接操作的独立产品面。
- 不把竞品的 agent dashboard、terminal mux、worktree manager 或 provider gateway 整套嵌入 Spark；只吸收能进入现有 owner 边界的领域闭环。
- 不用 Temporal、Restate、Inngest 等外部 durable engine 替换当前 daemon/SQLite 调度真相；只有隔离实验能证明本地 step journal 无法满足需求时才重新评估。

## 成功信号

- 同一 ask 的“算不算有效回答 / gate 是否满足”在 TUI、Cockpit、通道结算路径上共用 `spark-protocol` 语义，表面只做 UI。
- Slash / action catalog 继续以协议为源；Cockpit 与 TUI 只做 i18n 与执行。
- 新功能默认可在 TUI 或 Cockpit 验证，消息通道按 channel policy 收窄；无需先在 Pi 产品里跑通。
- Pi 产品加载路径可冻结：无新 `"pi.extensions"` 扩张；文档与边界检查区分 SDK 内核与产品兼容。宿主契约公开名为 `SparkHostAPI`（`spark-core`）；ask/tasks/context 注册入口为 `registerSpark*`。
- Spark 原生 TUI 可运行并行 side thread、恢复隔离历史并将全文或摘要显式 handoff 回主会话，过程中不加载 `pi-coding-agent`；Pi 兼容适配器通过同一纯状态契约保持行为一致。
- CI failure、review comment 与 merge conflict 能以幂等反馈事件回到创建该 change/PR 的原 session，并带可审查 evidence，而不是要求用户手工复制终端输出。
- Project-bound 命令、任务图、ask、roles、cue 的既有成功信号仍成立，并通过测试与 `vp check` / `prek` 守门。

## 当前开放问题

- 完成证据门禁应严格到什么程度：对人工任务、审查/设计任务和角色执行/工作流任务是否采用不同要求。
- 历史任务中被完成摘要覆盖的原始意图是否需要进一步从聊天记录、每日记忆或 Git 历史中恢复。
- `pi-btw` 的 Pi 产品兼容安装面应保留到哪个版本，以及原生 side-thread adapter 达到哪些真实 TUI 验收条件后可以移除根 manifest 暴露。

## 近期收尾任务

- 继续对齐跨表面 ask / gate / submit 语义；Cockpit 已改用协议 option `value` 与 `parseSparkAskChoice`。
- 文档与 AGENTS 边界语言改为“Pi SDK 内核 + Pi 产品冻结”。
- 后续可单独收缩 `pi-extension` 表面与 `"pi.extensions"` 元数据；该收缩不阻塞协议对齐。
- 以 `spark-turn/side-thread` 的纯状态契约为起点，实现 Spark 原生 store/runner/overlay adapter；`pi-btw` 在原生验收前继续作为冻结兼容实现。
- 将现有 PR/CI 读取能力收敛成 change delivery feedback 事件，先完成“失败反馈回原 session”，再考虑 GitHub Checks 回写。
- 会话队列双层收敛：TUI 乐观层 ↔ daemon `pendingTurns` 真相；Cockpit 继续只投影 daemon。
- `memory` owns durable scoped memory, recall candidates (`recall` tool), the `LearningStore` / `learning` tool, and reflection pipelines (`.spark/memory/reflections/`).

## 修订记录

- 2026-05-18：早期由兼容入口初始生成占位项目意图。
- 2026-05-22：根据历史任务审查、`spark-roles` 迁移、结构化提问、任务和 `cue` 边界，以及当时实现状态重建项目意图。
- 2026-06-05：根据门面切换、实现下沉和 `spark-core`、`spark-tasks`、`spark-learnings`、`spark-goal`、`spark-workflows` 退场更新当前边界。
- 2026-06-15：统一正式中文表述，保留必要代码标识符和兼容性术语。
- 2026-06-16：更新默认研究模式、`/implement` 模式命名以及 Spark 组合 Pi 扩展能力的边界表述。
- 2026-07-17：方向调整为以 Pi SDK 为内核、TUI/Cockpit/消息平台一等；Pi 产品宿主冻结并规划退场；跨表面交互协议以 `spark-protocol` 为源。
- 2026-07-20：确认会话队列双层模型与 memory 统一吸收 recall/learning。
- 2026-07-21：reflection 迁入 `spark-memory`；退役 `spark-learnings` / `spark-recall` 工作区包；reflection 落盘改为 `.spark/memory/reflections/`。
- 2026-07-21：`spark-extension-api` 硬切重命名为 `@zendev-lab/spark-core`（宿主契约 + 轻量 primitives；非复活旧能力袋）。
- 2026-07-21：清除 `ExtensionAPI` / 目标 `registerPi*` 技术债；宿主契约公开名为 `SparkHostAPI`，ask/tasks/context 注册入口为 `registerSpark*`。
- 2026-07-22：吸收本地 agent control-plane 竞品的交付闭环，决定将 `pi-btw` 拆为共享 side-thread 契约、Spark 原生 adapter 与冻结 Pi 兼容层；外部 durable engine 不替换 daemon 真相。
