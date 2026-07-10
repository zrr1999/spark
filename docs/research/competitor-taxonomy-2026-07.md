# Spark 竞品与相邻项目分类

> 研究输入，非产品承诺。用于对照 Spark 的三平面（daemon 执行 / server 协调 / tui 本地控制）+ Cockpit 网页宿主，以及 skills、memory、token 压缩等能力缺口。
>
> 收集日期：2026-07-09。星标数为抓取时快照，会随时间变化。

## 分类总览

| 类别 | 项目 | 与 Spark 的关系 |
| --- | --- | --- |
| A. 多智能体平台 / 运行时 | Multica、nyakore、nyako、Hermes Agent | 最接近「daemon + 协调 + 多客户端」形态 |
| B. 终端编码 Agent / TUI | snow-cli、oh-my-pi | 对照本地控制平面与 TUI 体验 |
| C. Pi 生态扩展 / 打磨 | pi-spark（zlliang）、pi-channels、pi-feishu | 同生态；channel 扩展对照 Assign 入口 |
| D. Skills / 方法论框架 | agent-skills、superpowers | 对照 workflow/skill 资产与开发方法论 |
| E. Goal / 工作流循环 | architect-loop | 对照 goal loop、高低配模型分工 |
| F. 本地检索 / Memory | qmd | 对照 `spark-memory` / 混合检索 |
| G. Token / 输出压缩 | lowfat | 对照 turn 层工具输出压缩 |
| H. Agent Shell 原语 | just-bash | 对照安全/可复现的 shell 执行面 |
| I. DSL / 可训练 harness | viba、Experience | 研究向；意图描述与可组合 harness |
| J. 误匹配 / 弱相关 | rusty_hermes | Hermes JS 引擎 Rust 绑定，非 Agent 产品 |

---

## A. 多智能体平台 / 运行时

### Spark Cockpit 目标（相对本节）

网页管理系统要从「投影展示」升级为「可直接安排 agent 工作」：

| 现状（偏展示） | 目标（可派活） |
| --- | --- |
| 看任务图 / 收件箱 / 产物 / daemon 连接态 | 在网页上创建/认领/指派任务给具体 runtime/session/role |
| 项目页聊天 ≈ 往主会话塞一条 `task.start.request` | 显式 **Assign**：选 agent、目标、约束、证据要求，再下发 |
| 进度靠镜像 invocation / snapshot | 派活后可跟踪、暂停/恢复/停止、看阻塞与决策 inbox |
| Cockpit SQLite 只做投影 | **保持**：执行真相仍在 daemon / `.spark`；网页只发协调命令 |

边界不变：Cockpit / `spark server` 发意图与协调命令；daemon 执行；网页不直接写 `.spark` 执行真相。

对标取舍：

- **Multica**：产品叙事最接近——agent 当队友，派任务、跟进度。
- **nyakore**：运行时模型最接近——session/activity/mailbox 可观测；网页是控制面入口，不是定义仓库。
- **nyako**：定义仓（agents/tools/skills）；与 nyakore 的 runtime/definition 分离对照 Spark 的 session registry vs role/skill 资产。
- **Hermes**：管理台 + 成长闭环可后置；首要不是嵌完整 TUI，而是 **派活与跟踪**。

Spark 派活边界（见 [`specs/assignment-and-channels.md`](../specs/assignment-and-channels.md)）：

- **统一 session 管理**（daemon）是底座。
- **Cockpit Assign** 与 **IM channels** 是同一 assignment 意图的两种入口，不是两套产品。
- 产品面学 **pi-channels**（adapters / routes / notify / ingress）；运行时语义学 **nyakore**（adapter 不跑 prompt、显式 reply）。
- 不引入 `gateway` 第二服务；不把 bot 长连接放进 TUI/Cockpit。

### [multica-ai/multica](https://github.com/multica-ai/multica)

- **一句话**：开源 managed agents 平台；把 coding agent 当队友——派任务、跟进度、沉淀 skills。
- **语言**：Go
- **为何归此类**：产品形态是「平台 + 多 agent + 任务分配」，最接近 Spark 的 server 协调平面 + 多 daemon/runtime 客户端。
- **对 Spark 网页的启发**：Assign UI（选 agent / 任务 / 验收）；进度与阻塞的操作台，而不只是列表；skills 作为可复用工作方式沉淀。

### [ShigureLab/nyakore](https://github.com/ShigureLab/nyakore)

- **一句话**：session-first 多智能体运行时核心；不拥有 agent 定义/prompt/产品行为。
- **语言**：TypeScript
- **为何归此类**：强调 runtime/definition 分离、session 路由、NNP 消息、薄 Pi host 适配与只读 dashboard。
- **对 Spark 网页的启发**：派活对象应是 **session/runtime activity**，不是抽象「聊天框」；dashboard 要能看到谁在跑、卡在哪、mailbox 积压；定义（role/skill）与运行时状态分离。
- **对 Spark channels 的启发**：adapter 只做 I/O；入站投递到 `conv_*` 式 session；出站显式 reply；已接 Telegram + Infoflow（非 Discord/Slack）。

### [ShigureLab/nyako](https://github.com/ShigureLab/nyako)

- **一句话**：赛博养猫定义仓——agents / tools / skills / schedules；runtime 由 nyakore 提供。
- **语言**：TypeScript
- **为何归此类**：与 nyakore 成对；对照 Spark「定义/资产」与「daemon session 真相」分离。
- **对 Spark 的启发**：固定 hub session + 外部 `conv_*` / `bridge_*`；聊天入口（nyako）与中枢（hub-neko）分工；平台会话不承担中枢职责。

### [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)

- **一句话**：「The agent that grows with you」——可成长的通用 Agent。
- **语言**：Python
- **为何归此类**：完整 Agent 产品/平台向，覆盖多 provider、长期使用与生态集成。
- **对 Spark 网页的启发**：本机管理台（配置/skills/memory/cron）与「派活」可并存，但 **派活优先于管理台皮肤**；嵌入式 Chat 是增强项，不是派活的唯一入口。

---

## B. 终端编码 Agent / TUI

### [MayDay-wpf/snow-cli](https://github.com/MayDay-wpf/snow-cli)

- **一句话**：终端里的 AI 编程智能体；兼容 OpenAI / Gemini / Claude / DeepSeek 等。
- **语言**：TypeScript
- **为何归此类**：本地 TUI/CLI coding agent，对照 Spark `spark tui` 本地控制平面。
- **对 Spark 的启发**：多 provider 统一入口；终端交互密度与日常可用性。

### [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)

- **一句话**：终端 AI coding agent——hash-anchored edits、优化 tool harness、LSP、Python、browser、subagents 等。
- **语言**：TypeScript（含 Rust 相关能力）
- **为何归此类**：强 TUI/工具面竞品；编辑与工具输出质量是核心卖点。
- **对 Spark 的启发**：工具 harness 与编辑锚点；subagent；浏览器/LSP 一体化。

---

## C. Pi 生态扩展 / 打磨

### [zlliang/pi-spark](https://github.com/zlliang/pi-spark)

- **一句话**：Pi package，打磨日常体验（compact TUI、credits、fullscreen 等）。
- **语言**：TypeScript
- **为何归此类**：Pi 扩展/皮肤层，不是独立三平面产品。
- **注意**：与本仓库产品名 **Spark** 撞名；文档与对外沟通需区分「zlliang/pi-spark 扩展」与「zendev Spark monorepo」。
- **对 Spark 的启发**：TUI chrome（editor/footer/credits）；Pi 扩展分发形态。

### [@amaster.ai/pi-channels](https://pi.dev/packages/@amaster.ai/pi-channels?name=feishu)

- **一句话**：Pi 多通道 messaging 扩展——Feishu / WeCom / DingTalk / webhook；adapters、routes、`notify`、bridge。
- **语言**：TypeScript
- **为何归此类**：channel 产品面最接近 Spark 要抄的配置与工具形状。
- **对 Spark 的启发**：`adapters` + `routes` + ingress 开关；飞书 WebSocket 优先、HTTP 可选；**不要**抄「bridge 拉起 Pi 子进程」——Spark 入站应进 daemon session/assignment。

### [pi-feishu](https://pi.dev/packages/pi-feishu?name=%E9%A3%9E%E4%B9%A6)

- **一句话**：飞书专用 Pi 聊天桥——进度卡片、中间文本、Typing reaction、媒体双向。
- **语言**：TypeScript
- **为何归此类**：单通道厚 UX；与 pi-channels 对照。
- **对 Spark 的启发**：飞书体验细节可后置参考；v1 不把进度卡片/reaction 当底座。Spark 取 **pi-channels 面 + nyakore 语义**，不以 pi-feishu 为长期架构。

---

## D. Skills / 方法论框架

### [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)

- **一句话**：面向 AI coding agents 的生产级 engineering skills。
- **语言**：JavaScript
- **为何归此类**：可安装 skill 资产库，跨 Cursor / Claude Code / Codex 等宿主。
- **对 Spark 的启发**：skill 打包与发现；把「怎么做工程」从 prompt 里抽成可版本化资产。

### [obra/superpowers](https://github.com/obra/superpowers)

- **一句话**：agentic skills 框架 + 可落地的软件开发方法论。
- **语言**：Shell
- **为何归此类**：方法论 + skill 运行时（brainstorming、subagent-driven development 等）。
- **对 Spark 的启发**：把 workflow 阶段做成 skill；子代理驱动开发的流程编排。

---

## E. Goal / 工作流循环

### [DanMcInerney/architect-loop](https://github.com/DanMcInerney/architect-loop)

- **一句话**：优化的 `/goal` 循环——强模型设计/评审，便宜模型实现，省 token、提质量。
- **语言**：Python
- **为何归此类**：目标驱动闭环，而非完整平台。
- **对 Spark 的启发**：goal loop 的模型分层；run manifest / 阶段技能化；与 `spark-loop` / workflow-run 对照。

---

## F. 本地检索 / Memory

### [tobi/qmd](https://github.com/tobi/qmd)

- **一句话**：本地 mini CLI 搜索引擎——文档、知识库、会议笔记；跟踪 SOTA，全本地。
- **语言**：TypeScript
- **为何归此类**：检索基础设施，不是 Agent 宿主。
- **对 Spark 的启发**：`spark-memory` 的混合检索（keyword + semantic）；与 Pi memory / qmd 集成路径一致。

---

## G. Token / 输出压缩

### [zdk/lowfat](https://github.com/zdk/lowfat)

- **一句话**：精简命令输出，去掉噪音，省 token。
- **语言**：Rust
- **为何归此类**：工具输出压缩专用工具。
- **对 Spark 的启发**：turn 层 tool-result compaction；与 `spark-turn` 已有压缩 profile 对照。

---

## H. Agent Shell 原语

### [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash)

- **一句话**：Bash for Agents——面向 Agent 的 shell 执行面。
- **语言**：TypeScript
- **为何归此类**：执行原语，不是完整 coding agent。
- **对 Spark 的启发**：可审计、可约束的 shell；与 cue/daemon 执行平面的边界对照。

---

## I. DSL / 可训练 harness（研究向）

### [lixinqi/viba](https://github.com/lixinqi/viba)

- **一句话**：vibe ADT——用代数类型运算描述意图的 DSL。
- **语言**：Python
- **为何归此类**：意图/类型描述层，偏研究与表达，非现成产品。
- **对 Spark 的启发**：任务/目标/计划的结构化意图描述是否值得 DSL 化。

### [lixinqi/Experience](https://github.com/lixinqi/Experience)

- **一句话**：基于 PyTorch 扩展的 self-improving harness——可组合 ops + 可训练 experience。
- **语言**：Python
- **为何归此类**：把 harness 当可训练模块，而非固定 skill 文本。
- **对 Spark 的启发**：长期「可学习的工作流」；与静态 skill/workflow 定义的边界。

---

## J. 误匹配 / 弱相关

### [rust-hermes/rusty_hermes](https://github.com/rust-hermes/rusty_hermes)

- **一句话**：Facebook/Meta Hermes JavaScript 引擎的 Rust 绑定。
- **语言**：Rust
- **为何归此类**：名称含 Hermes，但与 Nous Hermes Agent / Agent 产品无关。
- **对 Spark**：可忽略；勿与 `hermes-agent` 混为一谈。

---

## 按 Spark 平面的对照图

```text
                    ┌─────────────────────────┐
                    │  D Skills / 方法论        │
                    │  agent-skills            │
                    │  superpowers             │
                    └────────────┬────────────┘
                                 │ 资产/流程注入
┌──────────────┐    ┌────────────▼────────────┐    ┌──────────────┐
│ B TUI Agent  │    │ A 平台 / 运行时          │    │ F Memory     │
│ snow-cli     │◄──►│ Multica / nyakore /      │◄──►│ qmd          │
│ oh-my-pi     │    │ Hermes Agent             │    └──────────────┘
└──────┬───────┘    └────────────┬────────────┘
       │                         │
       │ 本地控制                 │ 协调 + 投影
       ▼                         ▼
┌──────────────┐    ┌─────────────────────────┐
│ Spark tui    │    │ Spark server + Cockpit  │
└──────────────┘    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Spark daemon 执行平面    │
                    │ + E goal loop            │
                    │ + G lowfat 压缩          │
                    │ + H just-bash 原语       │
                    └─────────────────────────┘
```

## 建议的跟进优先级（相对 Spark）

1. **最高（网页）**：Cockpit 从展示台 → **派活台**（Multica 叙事 + nyakore session/runtime 模型）
   - 显式 Assign：目标 / agent(runtime|session|role) / 约束 / 证据
   - 派活后跟踪：running / blocked / inbox decision / stop
   - 命令仍走 `spark server` → daemon，不把执行真相搬进 SQLite
2. **高**：qmd、lowfat（memory 检索与 token 压缩，已有局部实现可对齐）
3. **中**：architect-loop、superpowers / agent-skills（goal loop 与 skill 资产化）
4. **中**：oh-my-pi、snow-cli（TUI/工具 harness 体验）
5. **后置（网页）**：Hermes 式管理台（配置/MCP/cron/多通道）与嵌入式完整 Chat
6. **低 / 研究**：viba、Experience
7. **忽略**：rusty_hermes；对外沟通时区分 zlliang/pi-spark 与本仓库 Spark

## 来源列表（去重）

| 仓库 | URL |
| --- | --- |
| pi-spark | https://github.com/zlliang/pi-spark |
| snow-cli | https://github.com/MayDay-wpf/snow-cli |
| architect-loop | https://github.com/DanMcInerney/architect-loop |
| agent-skills | https://github.com/addyosmani/agent-skills |
| superpowers | https://github.com/obra/superpowers |
| Multica | https://github.com/multica-ai/multica |
| nyakore | https://github.com/ShigureLab/nyakore |
| oh-my-pi | https://github.com/can1357/oh-my-pi |
| rusty_hermes | https://github.com/rust-hermes/rusty_hermes |
| Hermes Agent | https://github.com/nousresearch/hermes-agent |
| qmd | https://github.com/tobi/qmd |
| just-bash | https://github.com/vercel-labs/just-bash |
| lowfat | https://github.com/zdk/lowfat |
| viba | https://github.com/lixinqi/viba |
| Experience | https://github.com/lixinqi/Experience |
