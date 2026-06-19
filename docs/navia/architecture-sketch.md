# Navia 总体设计

## 设计目标

Navia 是面向模型复现和智能体协作的项目工作台。它管理从工作区注册、资产声明、
项目创建、roadmap 规划、任务认领、执行记录、证据沉淀到验证结论的闭环。

系统的核心对象链路：

```text
Spark daemon 注册入口
  -> Workspace 运行时工作区
  -> Profile 声明资产
  -> Project 复现项目
  -> Roadmap 任务路线图
  -> TaskSpec 任务规格
  -> TaskPlan 宏观方案
  -> TODO 执行动作
  -> Run / Evidence / Verdict
```

## Workspace 与 Spark daemon

Spark daemon 和 Workspace 在产品概念上是一组关系：Spark daemon 是用来创建或注册
Workspace 的入口，Workspace 是实际承载项目、资产和运行状态的工作区。

创建 Spark daemon 表示在某台机器上注册一个可用工作路径。一个机器可以注册多个
Spark daemon，但每个 Spark daemon 使用的路径必须不同。创建 Workspace 时选择一个 Spark daemon，
并选择一个 Profile 或 fresh 模式。

```text
Spark daemon
├── machine
├── workspace_path
├── resource_capability
└── registration_state

Workspace
├── selected_profile | fresh
├── runtime_state
├── repos
├── agents
├── artifacts
└── projects
```

设计规则：

- Spark daemon 负责把某台机器上的某个路径注册为可创建 Workspace 的运行位置。
- Workspace 负责运行时状态、项目、工作副本、证据和项目级资产。
- 同一台机器允许多个 Spark daemon 注册，但路径不能重叠。
- Workspace 创建时从 Profile 复制或引用声明资产，然后进入运行时管理。
- 后续用户主要面对 Workspace，而不是 Spark daemon。

## Profile 与 Workspace

Profile 管声明，Workspace 管运行时。

Profile 描述一个 Workspace 创建时可以继承的默认资产：

```text
profile/
├── settings.toml
├── repos.toml
└── agents/
    └── agent_name/
        ├── agent.toml
        ├── skills/
        ├── memory/
        └── contracts/
```

Profile 包含：

- **settings.toml**：默认预算、信任策略、资源偏好、复现默认约束。
- **repos.toml**：可用仓库声明，包括参考实现、目标实现、工具仓库。
- **agents/**：智能体定义目录。每个 agent 内部声明自己的角色、工具权限、
  提示词、skills、memory 和 contracts。

Workspace 是 Profile 的运行时实例。它保存：

- 选用的 Profile 或 fresh 创建信息；
- 实际启用的 repos 和 agents；
- Project 列表；
- Workspace 级 artifacts；
- 运行状态、资源状态和证据索引；
- project 运行产生的工作副本和上下文。

逻辑结构：

```text
workspace/
├── profile/
│   ├── settings.toml
│   ├── repos.toml
│   └── agents/
│       └── agent_name/
│           ├── agent.toml
│           ├── skills/
│           ├── memory/
│           └── contracts/
├── repos/
├── artifacts/
└── projects/
    └── project_name/
        ├── project.toml
        ├── roadmap.toml
        ├── .worktrees/
        │   └── repo_name/
        │       └── branch_name/
        ├── clusters/
        │   └── cluster_name.toml  # task refs
        ├── tasks/
        │   └── task_id/
        │       ├── spec.toml
        │       ├── plan.md
        │       └── todos/
        ├── artifacts/
        └── inbox/
```

其中 `project.toml` 记录 Project 的目标、预算、约束和当前判定摘要；
`roadmap.toml` 记录 Task DAG、Cluster 聚类引用、里程碑和停止条件。

## Project、Roadmap、Cluster、Task

Project 是一次完整复现任务。创建 Project 后，智能体先规划 Roadmap。

```text
Project
└── Roadmap
    ├── Task[]
    │   ├── TaskSpec
    │   ├── TaskPlan
    │   └── TODO[]
    └── Cluster[]
        └── task_refs[]
```

### Project

Project 包含：

- 复现目标；
- 参考侧与目标侧描述；
- 预算和约束；
- 当前 verdict；
- Roadmap；
- Task 状态；
- Project 级 artifacts；
- Project inbox。

Project 回答：

```text
我们正在复现什么？
判定标准是什么？
当前路线图走到哪里？
哪些任务已完成、阻塞或需要人工决策？
```

### Roadmap

Roadmap 是 Project 的任务路线图，是当前方案的起点。

Roadmap 由 Task 组成。每个 Task 都要有 TaskSpec。Cluster 只是 Roadmap 中对
同类 Task 的聚类集合，不再作为任务依赖的主要边界。

Roadmap 包含：

- Task 列表；
- Task 依赖关系；
- 每个 Task 内部的 TaskSpec；
- 每个 Task 内部的 TaskPlan 状态；
- Cluster 聚类；
- 项目级里程碑；
- 当前优先级；
- 停止条件和预算条件。

Roadmap 解决的问题是：

```text
为了完成这个 Project，需要哪些 Task？
这些 Task 的依赖和优先级是什么？
哪些 Task 属于同一类问题方向？
完成到什么程度可以给出结论？
```

### TaskSpec

TaskSpec 是 Task 的规格说明，定义这个 Task 为什么存在、输入是什么、产出什么。

TaskSpec 包含：

```text
task_id
title
problem_statement
inputs
expected_outputs
completion_criteria
dependencies
required_capability
evidence_required
budget_hint
```

典型 Task：

- 规范化任务契约；
- 跑参考侧训练；
- 跑目标侧训练；
- 比较一组 checkpoint；
- 定位 forward 首分叉；
- 定位 backward 梯度差异；
- 增加一个观测点；
- 写一个数值 patch；
- 验证 patch scope；
- 汇总失败原因；
- 请求人工确认契约变更。

Task 是 Roadmap 的最小单位。Task 依赖可以跨 Cluster，因为 Cluster 只是聚类视图。

### TaskPlan

Roadmap 和 TaskSpec 构建完成后，需要为每个 Task 创建 TaskPlan。

TaskPlan 偏宏观设计和理论，不是执行 TODO。它回答：

```text
这个 Task 应该按什么思路解决？
需要验证什么假设？
可能需要哪些证据？
失败时应如何分支？
完成标准如何被判定？
```

TaskPlan 包含：

```text
approach
hypothesis
evidence_strategy
verification_strategy
risk
fallback
expected_artifacts
```

### TODO 与 Claim

TODO 是 TaskPlan 被认领后产生的具体执行项。Claim 是把 TaskPlan 转成 TODO 并
认领执行的动作。

Claim 时生成或认领 TODO，TODO 包含：

- 具体步骤；
- 运行命令或作业；
- 需要读取或生成的 artifact；
- 智能体执行上下文；
- 当前执行预算；
- 完成后的回报格式。

因此设计上分三层：

```text
TaskSpec = 任务是什么
TaskPlan = 为什么这样做、理论上怎么做
TODO = 这次具体怎么执行
```

### Cluster

Cluster 是 Roadmap 中同类 Task 的聚类集合。

Cluster 可以表示：

- task contract；
- reference replay；
- target determinism；
- forward divergence；
- backward divergence；
- optimizer state；
- patch validation；
- final regression。

Cluster 的作用：

- 帮助用户理解 Roadmap；
- 聚合相似任务的证据和状态；
- 形成问题方向视图；
- 作为进度和风险的摘要单位。

Cluster 不是依赖边界。Task 依赖由 Roadmap 直接管理。

## 设计分层

```text
交互层 Interaction Layer
├── Workspace / Profile 视图
├── Project 工作台
├── Roadmap 视图
├── TaskSpec / TaskPlan 视图
├── 证据与验证视图
└── Inbox 决策中心
        |
        v
智能层 Intelligence Layer
├── Agent 能力模型
├── Roadmap 规划
├── TaskSpec 生成
├── TaskPlan 生成
├── TODO 生成与 Claim 调度
├── 复现推理
├── Patch 与观测规划
└── 记忆与经验复用
        |
        v
执行层 Execution Layer
├── Workspace 运行时
├── 作业执行
├── 资源与环境管理
├── 运行记录
└── 证据账本
```

## 一、交互层

交互层处理人和系统之间的输入输出。

### Workspace / Profile 视图

展示：

- 已注册 Spark daemon；
- 可创建 Workspace 的路径和资源；
- Workspace 使用的 Profile 或 fresh 状态；
- `settings.toml`、`repos.toml`、`agents/`；
- agent 内部的 skills、memory、contracts；
- Workspace 级 artifacts。

用户在这里回答：

```text
这个工作区从哪个 Profile 创建？
它有哪些资源和智能体能力？
它运行在哪个已注册路径上？
```

### Project 工作台

展示：

- Project 目标；
- 当前 Roadmap 状态；
- 当前 verdict；
- 预算消耗；
- Cluster 聚类进度；
- 待 claim Task；
- 最近证据；
- patch 历史；
- Inbox 决策。

### Roadmap 视图

展示：

- Task DAG；
- TaskSpec 完整性；
- TaskPlan 完整性；
- Task 依赖；
- Cluster 聚类；
- 里程碑；
- 下一批可 claim Task。

Roadmap 视图的核心问题：

```text
Project 被拆成了哪些 Task？
每个 Task 是否有清晰 spec 和 plan？
哪些 Task 可以被 claim？
哪些 Task 阻塞了最终 verdict？
```

### TaskSpec / TaskPlan 视图

展示单个 Task 的规格和方案：

- TaskSpec；
- TaskPlan；
- 输入证据；
- 期望输出；
- 完成标准；
- 依赖；
- TODO / Claim 历史；
- 关联 Run 和 Artifact。

### 证据与验证视图

展示复现系统的证据链：

- task contract；
- observation contract；
- judge / report 指标；
- run manifest；
- compare result；
- validation verdict；
- divergence report；
- witness；
- patch record；
- resource usage。

这个视图的核心是区分：

```text
judge  指标：直接决定 PASS / FAIL
report 指标：辅助定位问题
```

### Inbox 决策中心

Inbox 汇总需要人工参与的事项：

- 创建 Workspace 时选择 Profile 或 fresh；
- 是否接受初始 Roadmap；
- 是否接受某个 TaskSpec；
- 是否接受某个 TaskPlan；
- 是否允许 claim 或调整优先级；
- 是否允许增加观测；
- 是否接受某个 patch 方向；
- 是否调整预算；
- 是否把 report 指标提升为 judge 指标；
- 是否接受最终结论。

Inbox 产出 `HumanDecision`，进入智能层继续调度。

## 二、智能层

智能层负责把 Project 目标和证据组织成 Roadmap、TaskSpec、TaskPlan 和下一步
Claim。

### Agent 能力模型

Agent 表示可复用能力定义。

Agent 能力包含：

- role；
- skills；
- tools；
- prompt；
- memory policy；
- 可处理的 Task 类型；
- 可访问的 Workspace 资产范围。

一次具体执行是 `AgentRun`，它来自某次 Claim，并绑定到某个 Task。

### Roadmap 规划

创建 Project 后，Agent 自动规划 Roadmap。

输入：

```text
ProjectGoal
WorkspaceAssets
ProfileAssets
MemoryHit
HumanDecision
```

输出：

```text
Roadmap
Task[]
Cluster[]
Milestone[]
StopCondition
```

规划规则：

- Roadmap 以 Task 为基本节点。
- 每个 Task 必须有 TaskSpec。
- Cluster 只是 Task 聚类，不限制 Task 依赖。
- Task 依赖由 Roadmap 直接表达。
- Roadmap 要标出可并行任务、关键路径和阻塞点。
- Roadmap 完成后进入 TaskPlan 生成阶段。

### TaskPlan 生成

TaskPlan 是 Task 的宏观方案。

输入：

```text
TaskSpec
EvidenceBundle
RelevantMemory
ProjectConstraints
```

输出：

```text
TaskPlan
```

生成规则：

- TaskPlan 说明解题思路，而不是执行脚本。
- TaskPlan 必须说明需要哪些证据。
- TaskPlan 必须说明完成标准如何验证。
- TaskPlan 可以给出 fallback。
- TaskPlan 通过后，Task 才进入可 claim 状态。

### TODO 生成与 Claim 调度

Claim 调度把可 claim Task 转成具体执行 TODO。

输入：

```text
TaskSpec
TaskPlan
CurrentEvidence
ResourceState
AgentCapability
```

输出：

```text
TODO
JobSpec
AgentRun
```

Claim 规则：

- TODO 是一次具体执行上下文，由 claim 动作产生或认领。
- 同一个 Task 可以有多次 Claim 尝试。
- 每次 Claim 必须回写 Run、Artifact、ResourceUsage 或失败原因。
- Claim 结果进入证据账本，再由智能层更新 Roadmap。

### 复现推理

复现推理处理“为什么不一致”和“下一步验证什么”。

核心对象：

```text
AlignmentProblem
AlignmentContract
ExecutionWitness
EvidenceBundle
ObservationPlan
ComparisonPlan
DivergenceReport
VerificationVerdict
```

核心能力：

- 构造或修正复现任务契约；
- 区分 judge 与 report；
- 检查 manifest 是否匹配；
- 判断是否具备判定资格；
- 定位首个分叉检查点；
- 根据分叉位置生成下一步观测或 patch 方向；
- 在证据不足时输出 `NO_JUDGEMENT`。

### Patch 与观测规划

Patch 规划必须明确 patch 的意图和影响范围。

Patch 类型：

- **数值 patch**：改变计算路径，用于消除数值差异。
- **观测 patch**：增加 hook、probe、dump，用于收集信息。
- **验证 patch**：作用于参考侧，使参考运行可重放。
- **复合 patch**：同时改变计算和增加观测，需要显式标记。
- **干扰性诊断**：有副作用的临时诊断，只能辅助定位。

Patch 记录必须包含：

```text
patch id
patch type
hypothesis
scope
based_on_evidence
validation_result
status
```

数值 patch 的验证规则：

```text
scope 内允许变化
scope 外必须不变
```

观测 patch 的验证规则：

```text
带观测运行与无观测基线的 judge 指标一致，才能信任该观测。
```

### 记忆与经验复用

记忆用于帮助规划 Roadmap、生成 TaskPlan 和安排 Claim 优先级。

MemoryEntry 可以记录：

- 某类算子的历史分叉模式；
- 某个 patch 曾经解决的问题；
- 某类 hook 的干扰风险；
- 某个 profile 的适用条件；
- 某个任务契约的已知坑。

MemoryHit 可以影响优先级，但不能替代验证结论。

## 三、执行层

执行层负责把 TODO 和 JobSpec 变成实际运行，并把结果写入证据账本。

### Workspace 运行时

Workspace 运行时负责：

- 维护 Workspace 的运行状态；
- 绑定已注册 Spark daemon 路径；
- 管理 Project 工作副本；
- 管理项目运行上下文；
- 记录资源状态。

### 作业执行

核心输入输出：

```text
Input:
JobSpec

Output:
JobResult
ArtifactRefs
ResourceUsage
```

Job 类型：

- prepare environment；
- run reference；
- run target；
- compare；
- verify；
- locate divergence；
- apply patch；
- build；
- test；
- train；
- collect artifact；
- cleanup。

作业执行只关心任务能否被稳定运行和记录。模型语义判断由智能层完成。

### 资源与环境管理

资源与环境管理负责：

- CPU、内存、磁盘、GPU；
- 工作副本；
- 数据和 checkpoint；
- 容器或环境；
- 并发和排队；
- 取消、重试、超时；
- 清理和保留策略。

它向系统报告 `ResourceUsage`，用于调度层判断预算、瓶颈和下一步安排。

### 运行记录

每次运行必须产生 manifest。

Manifest 记录：

- task id；
- claim id；
- task contract hash；
- task plan hash；
- 数据 hash；
- 代码版本；
- 框架版本；
- 设备和环境；
- profile；
- patch registry snapshot；
- 关键环境变量；
- 输入 artifact；
- 输出 artifact。

Manifest 的作用是让每个 verdict、patch 和 divergence 都能追溯到具体运行条件。

### 证据账本

证据账本是系统事实来源。

存储对象：

```text
Artifact
RunRecord
ClaimRecord
Trace
TensorHash
Checkpoint
ExecutionWitness
AlignmentContract
PatchRecord
ValidationReport
DivergenceReport
MemoryEntry
ResourceUsageRecord
HumanDecisionRecord
```

证据规则：

- 证据采用 append-only 思路；
- 结论关联到支撑证据；
- failed attempt 保留为后续推理输入；
- patch 关联到触发它的 divergence、witness 和 validation；
- report 可以帮助定位，judge 才能决定 verdict；
- 无效 patch 标记状态并保留历史；
- memory 提供参考，最终判断回到证据链。

## 复现判定闭环

模型复现项目围绕明确的判定闭环运行：

```text
任务契约
  -> TaskPlan
  -> TODO
  -> 参考侧运行
  -> 目标侧运行
  -> 比较输出
  -> 验证器判定
  -> 首分叉定位
  -> 增加观测或生成 patch
  -> 重跑验证
```

验证器输出：

```text
PASS
FAIL
NO_JUDGEMENT
```

含义：

- **PASS**：所有 judge 指标满足复现目标。
- **FAIL**：前置条件满足，但至少一个 judge 指标存在差异。
- **NO_JUDGEMENT**：前置条件不满足，系统还没有资格判定。

进入 PASS / FAIL 判定前必须满足：

- judge 文件齐全；
- 两侧 manifest 匹配；
- patch registry 对称；
- 观测 profile 通过非干扰验证；
- 参考侧可重放；
- 任务契约、观测契约和 witness 足够闭合。

## 设计材料拆分

总体设计只保留对象关系、层次边界和数据流。每层的具体调研、详细设计和落地
计划应按专题拆分。

建议拆分：

- **Spark daemon / Workspace 专题**：Spark daemon 注册、路径互斥、Workspace 创建、
  Profile / fresh 选择、运行时状态。
- **Profile 专题**：settings.toml、repos.toml、agents/，以及 agent 内部的
  skills、memory、contracts。
- **Project / Roadmap 专题**：Project 契约、Roadmap 生成、Task DAG、Cluster
  聚类、里程碑和停止条件。
- **TaskSpec / TaskPlan / TODO / Claim 专题**：TaskSpec 字段、TaskPlan 结构、
  TODO 生成、Claim 动作和结果回写。
- **交互层专题**：Workspace/Profile 视图、Project 工作台、Roadmap 视图、
  TaskSpec/TaskPlan 视图、证据视图、Inbox 决策中心。
- **Agent 专题**：AgentSpec、skills、tools、memory policy、AgentRun、任务
  分派规则。
- **复现契约专题**：task contract、observation contract、judge/report、
  profile、manifest、verdict、NO_JUDGEMENT。
- **Patch 与观测专题**：patch registry、patch scope、非干扰验证、无效 patch
  归档、指标提升规则。
- **执行层专题**：JobSpec、作业类型、资源预算、工作副本、环境、取消重试、
  清理保留策略。
- **证据账本专题**：Artifact、RunRecord、ClaimRecord、Trace、Witness、
  PatchRecord、ValidationReport、DivergenceReport、MemoryEntry、provenance。

每个专题应回答三类问题：

```text
它管理哪些对象？
它接收和产出哪些数据？
它的结论如何回到 Workspace / Project / Roadmap / Task / Evidence？
```

## 主流程

```text
1. 用户在机器上注册 Spark daemon，得到一个可创建 Workspace 的路径。
2. 用户创建 Workspace，选择 Profile 或 fresh，并选择 Spark daemon。
3. Workspace 获得 settings、repos 和 agents；agent 内含 skills、memory、contracts。
4. 用户创建 Project，定义复现目标、预算和约束。
5. Agent 为 Project 生成 Roadmap。
6. Roadmap 生成 Task DAG，并给每个 Task 生成 TaskSpec。
7. 每个 TaskSpec 生成 TaskPlan。
8. 可执行 Task 被 claim，TaskPlan 转成 TODO。
9. TODO 产生 JobSpec 或 AgentRun。
10. 执行层运行 JobSpec，产出 RunRecord、ArtifactRefs 和 ResourceUsage。
11. 证据账本追加 manifest、trace、checkpoint、compare、verdict 和 patch record。
12. 复现推理读取证据，生成 DivergenceReport、PatchProposal 或 NO_JUDGEMENT。
13. 调度层更新 Roadmap、Task 状态、优先级和停止原因。
14. 交互层展示 Project 状态、Roadmap、证据链、失败原因、patch 历史和 Inbox 决策。
```
