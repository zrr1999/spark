---
description: "pi-spark: Spark workflow suite for Pi"
owner: zrr1999
created: 2026-05-18
updated: 2026-06-05
inspired_by:
   - pi
   - cue-shell
   - pi-ask
   - pi-roles
---

# pi-spark 项目意图

## 起源

pi-spark 是 Pi 的 Spark 套件：以 `/spark <idea>` 作为用户入口，把项目意图、project/task DAG、ask、review、artifact、role run、cue-shell 执行等能力组织成可追溯的本地工作流。早期 `SPARK.md` 由占位意图生成；当前文件根据已落地的 package 边界、历史任务审查和最新实现状态重建。

## 当前工作标题

- Pi Spark workflow suite
- 面向 Pi 的本地 agentic development orchestration

## 目标

- 让 `/spark` 能从一个初始想法创建或恢复本地 Spark 状态，而不是依赖聊天上下文记忆。
- 用 durable project/task DAG 表达工作分解、依赖、claim、TODO、run 和完成状态。
- 用 typed artifacts 记录 ask 答案、role-run 输出、review、run trace 和后续证据。
- 把 ask 作为 workflow primitive：在 project/task/roadmap/review 流程需要真实澄清或决策时调用，而不是展示宽泛 intake 表单。
- 把 reusable role 定义和单次 child Pi 执行下沉到 `pi-roles`；Spark 只负责 DAG/task/artifact/review/ask 编排。
- 把 cue-shell 执行能力作为 `pi-cue` 的可复用底座，默认输出应上下文友好、可按需展开。
- 把 task plan/readiness/evidence 作为完成状态约束，避免 failed/not_started/empty run 被误判为完成。

## 当前包边界

Spark 现在支持两个 host target：Pi 中的 `packages/spark/src/extension/` 仍是 `/spark` 等命令和 facade 的 Pi extension 入口；`packages/spark-cli` 是原生 `pi-tui` host，直接构造 `SparkHostRuntime`、显式 builtin extension loader、provider registry、model selector、JSONL session store、三层 skill resolver 与 `SparkAgentLoop`。共享 extension package 通过 `pi-extension-api` 运行在两边，不应依赖具体 Pi SDK runtime。

- `packages/spark`：Pi extension facade、`/spark`、`/research`、`/plan`、`/execute`、`/goal`、`/workflow`、Spark widget、mode/policy、builtin Spark roles 与 active context provider。
- `packages/spark-runtime`：单个 Spark task/role-run 执行适配，负责调用 `pi-roles` 并回写 artifacts/runs/status。
- `packages/pi-extension-api`：共享 extension host/tool contract、refs、errors 与轻量 JSON/fs/time helpers。
- `packages/pi-artifacts`：artifact/evidence metadata/blob store、provenance/lineage 与 canonical `artifact({ action })` tool。
- `packages/pi-tasks`：generic project/task/TODO/run graph、依赖、claim/lease、TaskPlan readiness、task/run 状态与 canonical `task({ action })` tool。
- `packages/pi-learnings`：evidence-backed reusable learning store、`.learnings/` local/user scope、export/import/lifecycle 与 canonical `learning({ action })` tool。
- `packages/pi-goal`：generic goal state 与 continuation prompt primitives；Spark 只保留 project-bound `/goal` facade，历史 serialized marker 保持兼容。
- `packages/pi-workflows`：saved workflow discovery/runtime primitives 与 `.spark/workflow-runs.json` DAG/workflow-run store。
- `packages/pi-ask`：通用 canonical `ask({ action })` 协议、内部 focused/flow 状态机、TUI 渲染与 result semantics；具体 ask 问题由调用处基于实际上下文生成，不提供制式表单。
- `packages/pi-roles`：`RoleSpec`、project/user/builtin role store、`RoleRun` fresh/forked child Pi 执行、role tools；不拥有 task DAG。
- `packages/pi-cue`：cue-shell IPC/tool adapter；不依赖 Spark 状态。
- `packages/pi-context`：bounded registered context providers。
- `packages/pi-recall`：explicit scoped recall candidates，语义上不同于 `.learnings/`。
- `packages/spark-cli`：Spark-first native TUI host；host-only 代码在 `src/host/`，pi-tui wrappers 在 `src/tui/`，不嵌入 `@earendil-works/pi-coding-agent`。

已退场 workspace 包：`spark-core`、`spark-tasks`、`spark-learnings`、`spark-goal`、`spark-workflows`。`pi-* -> spark-*` 反向依赖由 `pnpm run check:boundaries`、`prek` 和 CI static checks 守门。`.spark/` 目录、`.spark/projects.json`、`.spark/workflow-runs.json` 和历史 goal marker 属于 on-disk/schema compatibility，不因包名迁移而改名。

## 非目标

- 不把本仓库泛化为公开模板或通用项目管理产品。
- 不复制 OpenSpec/OpenArc 的完整文件树、change directory 或重型流程。
- 不在 `pi-roles` 中引入 Spark DAG、task claim、artifact 或 scheduler 语义。
- 不保留旧 `spark-agents` / `pi-agent-run` 公开兼容包；只对必要的历史持久化状态保留窄读兼容。
- 不保留长期 `spark_*` tool aliases 或双 public/default tool surface；外部工具表面使用 canonical `task`、`learning`、`artifact`、`ask`、`goal` 等，action tool 渲染为 `tool action=<value> ...`。
- 不让 ask 成为用户必须直接操作的独立产品面；它应服务具体 project/task/roadmap/review flow。
- 不默认隐藏或吞掉执行证据；输出可精简，但完整证据应可通过 artifacts/full/tail 参数取回。

## 成功信号

- `/spark` 初始化/恢复不会覆盖既有状态，不会生成占位任务，也不会要求用户先填宽泛表单。
- `task({ action: "status" })` 和 Spark widget 能以低噪声方式展示当前 project、active tasks、TODO、workflow-run 状态和 readiness 问题。
- `task({ action: "plan" })` / `task({ action: "claim" })` / `task({ action: "run_ready" })` 能区分规划、claim、执行和完成；role-run 失败或 not_started 不会错误完成 task。
- `ask({ action: "ask" | "flow" })` 的 focused/flow 结果语义一致：custom input 一等公民，decision/approval 无有效选项时阻塞，用户界面不泄漏 raw ids。
- `pi-roles` role-spec/run 工具与 Spark workflow-run 执行边界清晰，direct `role({ action: "call" })` 不冒充 task execution。
- `pi-cue` 工具默认输出 bounded/context-friendly，同时保留获取完整输出的显式方式。
- 关键行为有 tests/typecheck/`vp check` 覆盖，并通过 `prek`/CI 验证。

## 当前开放问题

- Roadmap 已作为每个 Project 内嵌的唯一 planning 层落在 `projects.json`；后续是否抽成独立 `pi-planning` capability 仍待观察。
- done 完成证据门禁应严格到什么程度：对人工任务、review/design 任务和 role-run/DAG 任务是否采用不同要求。
- 历史任务中被完成摘要覆盖的原始意图是否需要进一步从聊天记录、daily memory 或 git 历史中恢复。

## 近期收尾任务

- 完成当前包边界迁移后的最终文档同步。
- 后续可单独 micro-split 仍偏大的 implementation files（如部分 task/runtime internals），但不阻塞当前边界迁移。

## 修订记录

- 2026-05-18：由 `/spark` 初始生成占位项目意图。
- 2026-05-22：根据历史任务审查、pi-roles 迁移、ask/task/cue 边界与当时实现状态重建项目意图。
- 2026-06-05：根据 facade cutover、实现下沉和 `spark-core`/`spark-tasks`/`spark-learnings`/`spark-goal`/`spark-workflows` 退场更新当前边界。
