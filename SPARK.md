---
description: "pi-spark: Spark workflow suite for Pi"
owner: zrr1999
created: 2026-05-18
updated: 2026-05-22
inspired_by:
   - pi
   - cue-shell
   - pi-ask
   - pi-roles
---

# pi-spark 项目意图

## 起源

pi-spark 是 Pi 的 Spark 套件：以 `/spark <idea>` 作为用户入口，把项目意图、thread/task DAG、ask、review、artifact、role run、cue-shell 执行等能力组织成可追溯的本地工作流。早期 `SPARK.md` 由占位意图生成；当前文件根据已落地的 package 边界、历史任务审查和最新实现状态重建。

## 当前工作标题

- Pi Spark workflow suite
- 面向 Pi 的本地 agentic development orchestration

## 目标

- 让 `/spark` 能从一个初始想法创建或恢复本地 Spark 状态，而不是依赖聊天上下文记忆。
- 用 durable thread/task DAG 表达工作分解、依赖、claim、TODO、run 和完成状态。
- 用 typed artifacts 记录 ask 答案、role-run 输出、review、run trace 和后续证据。
- 把 ask 作为 workflow primitive：在 thread/task/roadmap/review 流程需要真实澄清或决策时调用，而不是展示宽泛 intake 表单。
- 把 reusable role 定义和单次 child Pi 执行下沉到 `pi-roles`；Spark 只负责 DAG/task/artifact/review/ask 编排。
- 把 cue-shell 执行能力作为 `pi-cue` 的可复用底座，默认输出应上下文友好、可按需展开。
- 逐步把 task plan/readiness/evidence 变成完成状态的约束，避免 failed/not_started/empty run 被误判为完成。

## 当前包边界

- `packages/spark`：Pi extension facade、`/spark`、Spark 工具注册、状态展示、workflow flow wiring。
- `packages/spark-core`：共享 ref、schema、错误、TaskPlan/Role/Artifact/Ask/Review/Cue/Trace 等核心契约。
- `packages/spark-tasks`：thread/task DAG、依赖、claim/lease、TODO、TaskPlan readiness、run/task 状态存储。
- `packages/spark-runtime`：Spark DAG/role-run 执行适配，负责把 ready tasks 交给 `pi-roles` 并回写 artifacts/runs/status。
- `packages/spark-artifacts`：typed artifact store、hash/blob/provenance/lineage。
- `packages/spark-ask`：Spark-specific ask copy/presets/tool helpers，建立在 `pi-ask` 和 artifacts 之上。
- `packages/pi-ask`：通用 ask_user/ask_flow 协议、状态机、TUI 渲染、result semantics。
- `packages/pi-roles`：`RoleSpec`、project/user/builtin role store、`RoleRun` fresh/forked child Pi 执行、role tools；不拥有 Spark task DAG。
- `packages/pi-cue`：cue-shell IPC/tool adapter；不依赖 Spark 状态。
- `packages/spark-review`：review gate 和 review artifact helpers。

## 非目标

- 不把本仓库泛化为公开模板或通用项目管理产品。
- 不复制 OpenSpec/OpenArc 的完整文件树、change directory 或重型流程。
- 不在 `pi-roles` 中引入 Spark DAG、task claim、artifact 或 scheduler 语义。
- 不保留旧 `spark-agents` / `pi-agent-run` 公开兼容包；只对必要的历史持久化状态保留窄读兼容。
- 不让 ask 成为用户必须直接操作的独立产品面；它应服务具体 thread/task/roadmap/review flow。
- 不默认隐藏或吞掉执行证据；输出可精简，但完整证据应可通过 artifacts/full/tail 参数取回。

## 成功信号

- `/spark` 初始化/恢复不会覆盖既有状态，不会生成占位任务，也不会要求用户先填宽泛表单。
- `spark_status` 和 Spark widget 能以低噪声方式展示当前 thread、active tasks、TODO、DAG manager 和 readiness 问题。
- `spark_plan_tasks` / `spark_claim_task` / `spark_run_ready_tasks` 能区分规划、claim、执行和完成；role-run 失败或 not_started 不会错误完成 task。
- `ask_user`、`ask_flow`、`spark_ask` 的结果语义一致：custom input 一等公民，decision/approval 无有效选项时阻塞，用户界面不泄漏 raw ids。
- `pi-roles` role-spec/run 工具与 Spark DAG 执行边界清晰，direct `call_role` 不冒充 task execution。
- `pi-cue` 工具默认输出 bounded/context-friendly，同时保留获取完整输出的显式方式。
- 关键行为有 tests/typecheck/`vp check` 覆盖，并通过 prek/CI 风格验证。

## 当前开放问题

- Project-bound roadmap 模型如何最小落地：先 flow-local 原型、放入 `spark-core`，还是后续独立 `spark-roadmap`。
- `spark-tasks` 中哪些概念应下沉为通用 `pi-tasks`，哪些继续保持 Spark 专属。
- legacy `agentRef` / `agentName` / `subagent` / `agent:*` / `managed` / `predefined` 兼容输入的最终迁移窗口与删除顺序。
- done 完成证据门禁应严格到什么程度：对人工任务、review/design 任务和 role-run/DAG 任务是否采用不同要求。
- 历史任务中被完成摘要覆盖的原始意图是否需要进一步从聊天记录、daily memory 或 git 历史中恢复。

## 近期收尾任务

- 补齐历史 done 异常任务的完成证据或处置结论。
- 完成 task plan 澄清前移到规划阶段后的验证和文档收口。
- 实现或确认 project-bound roadmap 原型方案。
- 清理 legacy agent terminology/compat 输入。
- 强化 done completion evidence gate。

## 修订记录

- 2026-05-18：由 `/spark` 初始生成占位项目意图。
- 2026-05-22：根据历史任务审查、pi-roles 迁移、ask/task/cue 边界与当前实现状态重建项目意图。
