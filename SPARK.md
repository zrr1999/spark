---
description: "spark：以 Pi SDK 为内核，统一 TUI / Cockpit / 消息平台的本地智能开发编排"
owner: zrr1999
created: 2026-05-18
updated: 2026-07-23
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

`spark` 最初作为面向 Pi 产品的工作流套件起步，通过意图明确的用户命令与规范化工具，将项目意图、任务有向无环图、结构化提问、审查、证据制品、角色执行以及 `cue-shell` 执行能力组织为可追溯的本地工作流。仓库落地后，执行与会话中枢已迁移到 Spark daemon，产品面扩展为原生 TUI、Cockpit Web 与消息通道；**Pi SDK**（`@earendil-works/pi-ai`、`@earendil-works/pi-tui` 及与之对齐的流式/会话形状）仍是模型与终端呈现内核，独立的 Pi 产品 extension facade 已退场，兼容加载器与原生宿主共用 `spark-extension`。

## 当前工作标题

- Spark 本地智能开发编排
- 统一 TUI / Cockpit / 消息平台，Pi SDK 为内核

## 目标

- 以 daemon 为持久会话与调用调度真源；TUI、Cockpit、消息通道、本地 RPC 共用一套 registry 与 invocation，不维护并行会话状态机。
- 以 daemon 为 `goal | loop | repro | implement | workflow | session_todo` 的唯一自治运行时；计时、generation、重试、恢复和 fresh 隐藏执行均进入 SQLite 与现有 invocation scheduler，前端只发控制命令并展示投影。
- 在 `spark-protocol` 中沉淀跨表面交互协议（ask 判定、slash/action catalog、session status / pending turns、可展示错误），各表面只保留呈现与执行胶水。
- 保持 Pi SDK 为内核：模型流、provider、终端 UI 原语继续建立在 `pi-ai` / `pi-tui`（经 `spark-ai` / `spark-tui` 边界）之上，不把“退场 Pi 产品”误解为剥离 SDK。
- 由 `spark-extension` 统一拥有产品 extension 组合；`package.json#pi` 仅保留指向同一实现的兼容发现元数据，不保留第二套 facade 或 `pi-coding-agent` 运行时依赖。
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
- **产品 extension 组合根**：`packages/spark-extension` 为原生与结构兼容宿主注册 command/tool/policy；历史 `pi-extension` workspace 已退场。根 `"pi": { "extensions": ... }` 只让兼容加载器发现同一 Spark 实现，不形成第二套能力或状态 owner。

已退场的工作区包包括历史能力袋 `spark-core`（与现 `@zendev-lab/spark-core` 无关）、`spark-goal`、`spark-learnings` 与 `spark-recall`。`spark-tasks`、`spark-workflows` 仍是当前包；learning / recall / reflection 由 `spark-memory` 拥有。`pi-* -> spark-*` 反向依赖由边界检查守门。`.spark/` 磁盘格式不因包名迁移而改名（reflection 落盘路径统一到 `.spark/memory/reflections/` 除外）。

## 非目标

- 不将本仓库泛化为公开模板或通用项目管理产品。
- 不剥离或重写 Pi SDK 内核去“去 Pi 化”；退场对象是 Pi **产品**宿主，不是 `pi-ai` / `pi-tui`。
- 不为兼容加载器新增独立能力；不重新建立双重 extension 实现或公开工具表面。
- 不把 TUI 进程内 follow-up 队列与 daemon `pendingTurns` 盲目合并成单一数组；采用双层模型：daemon `pendingTurns` 是跨表面耐久真相，TUI `queuedFollowUps` 只保留未 ack 的乐观 steer/followUp（合并、编辑器恢复），ack 后以 daemon 投影为准。
- 不把 Cockpit 专用 notice/error part 未经设计提升进协议。
- 不复制 OpenSpec/OpenArc 的完整文件树或重型流程。
- 不让结构化提问成为用户必须直接操作的独立产品面。
- 不把竞品的 agent dashboard、terminal mux、worktree manager 或 provider gateway 整套嵌入 Spark；只吸收能进入现有 owner 边界的领域闭环。
- 不用 Temporal、Restate、Inngest 等外部 durable engine 替换当前 daemon/SQLite 调度真相；只有隔离实验能证明本地 step journal 无法满足需求时才重新评估。
- 不实现 root 跨 Unix 用户 supervisor；多用户部署采用每个 Unix 用户独立运行一个 Spark daemon。

## 成功信号

- 同一 ask 的“算不算有效回答 / gate 是否满足”在 TUI、Cockpit、通道结算路径上共用 `spark-protocol` 语义，表面只做 UI。
- Slash / action catalog 继续以协议为源；Cockpit 与 TUI 只做 i18n 与执行。
- 新功能默认可在 TUI 或 Cockpit 验证，消息通道按 channel policy 收窄；无需先在 Pi 产品里跑通。
- 兼容加载路径只指向 `spark-extension`：无第二个 facade package、无新 `"pi.extensions"` 扩张；文档与边界检查区分 SDK 内核与兼容发现元数据。宿主契约公开名为 `SparkHostAPI`（`spark-core`）；ask/tasks/context 注册入口为 `registerSpark*`。
- Spark 原生 TUI 与 Cockpit 通过同一 daemon controller 运行只读 Side Thread、恢复隔离历史并将全文或紧凑摘要显式 handoff 回主会话；TUI 使用单一 `/btw` 命令，Cockpit 提供同一组 ensure、ask、reset、model、thinking 与 handoff 操作，两个表面都不加载 `pi-coding-agent`。
- 用户可从 npm 安装单一 `@zendev-lab/spark` 产品包并获得 `spark` 命令；发布物只包含编译后的 JavaScript、声明过的运行时依赖以及 daemon migrations、TUI 和 Cockpit 资产，不暴露内部 workspace 包图。
- CI failure、review comment 与 merge conflict 能以幂等反馈事件回到创建该 change/PR 的原 session，并带可审查 evidence，而不是要求用户手工复制终端输出。
- Project-bound 命令、任务图、ask、roles、cue 的既有成功信号仍成立，并通过测试与 `vp check` / `prek` 守门。

## 当前开放问题

- 完成证据门禁应严格到什么程度：对人工任务、审查/设计任务和角色执行/工作流任务是否采用不同要求。
- 历史任务中被完成摘要覆盖的原始意图是否需要进一步从聊天记录、每日记忆或 Git 历史中恢复。

## 近期收尾任务

- 继续对齐跨表面 ask / gate / submit 语义；Cockpit 已改用协议 option `value` 与 `parseSparkAskChoice`。
- 文档与 AGENTS 边界语言已统一为“Pi SDK 内核 + 单一 `spark-extension` 组合根”。
- 历史 `pi-extension` workspace 已并入 `spark-extension`；`"pi.extensions"` 兼容元数据只允许指向现有 Spark entries。
- Spark 原生 Side Thread 已通过隔离的真实 TUI/Zellij 验收：提交与繁忙并行拒绝、daemon 重启恢复、model/thinking 配置、全文和摘要 handoff 均由真实 daemon invocation 验证。Cockpit 使用同一 daemon controller 提供完整 BTW 操作；旧 `pi-btw` 包、skill 与 Pi discovery 已删除。
- 以 `pnpm run check` 的 architecture ratchet 守住工作区数量、生产文件体量和冻结 Pi manifest；前期 ceiling 保留适度扩展余量，但新增 workspace 仍须证明稳定依赖边界。先通过 `pnpm run report:hygiene` 分类 Knip/jscpd/complexity 的动态入口误报，再把稳定基线升级为非增长门禁。
- Spark v0.1 通过生成的自包含 `@zendev-lab/spark` 产物发布 npm；源码 workspace 保持 private，完整 check 校验公开产品与内部 owner 分类，`pnpm run smoke` 在仓库外安装 tarball 并验证 dispatcher、TUI、daemon migrations/lifecycle 与 Cockpit health。
- 将现有 PR/CI 读取能力收敛成 change delivery feedback 事件，先完成“失败反馈回原 session”，再考虑 GitHub Checks 回写。
- 会话队列双层收敛：TUI 乐观层 ↔ daemon `pendingTurns` 真相；Cockpit 继续只投影 daemon。
- 自治 driver 硬切完成后，以它替代 marrow-core 的核心运行时；systemd 安装、自检/doctor、独立更新器、外部服务托管、profile 导入完善与日志保留作为非阻塞运维 TODO，且不得形成第二个运行时 owner。
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
- 2026-07-22：完成 Spark 原生 Side Thread 的 daemon 真相源、TUI 命令与 Cockpit 只读投影首个切片，并将架构增长、开源依赖采纳和发布闭包风险写入正式契约。
- 2026-07-22：实测发现 Node 不支持在 `node_modules` 内 strip TypeScript，且 daemon bundle 曾遗漏 migration assets；因此 v0.1 收敛为全仓私有源码分发，移除 registry publish 面并增加真实 source build/start smoke。
- 2026-07-22：真实 TUI/Zellij 验收覆盖 Side Thread 提交、繁忙并行、重启恢复、配置及 full/summary handoff，并修复旧 generation-less 转录在 daemon 升级重启后的兼容读取；决定 `pi-btw` 仅随 Pi 产品宿主整体退场，modal overlay 不作为门禁。
- 2026-07-23：用户确认恢复 npm 发布、以原生 BTW 完全替代并删除 `pi-btw`、Cockpit 与 TUI 共用 daemon Side Thread controller，同时为早期架构增长 ceiling 留出适度余量；发布面收敛为编译后、自包含的 `@zendev-lab/spark` 产品包，内部 workspace 不成为公共 API。
- 2026-07-23：将 `pi-extension` 完整并入 `spark-extension`，原生与兼容加载器共用单一组合根；继续保留 `pi-ai` / `pi-tui` SDK 内核。
- 2026-07-23：将 goal/loop/repro/implement/workflow/session TODO 的计时、generation、重试、恢复与 fresh continuity 硬切到 daemon；确定每个 Unix 用户独立 daemon，并将 marrow-core 的非核心运维便利能力转为 Spark TODO。
