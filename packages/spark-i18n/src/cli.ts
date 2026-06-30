import type { SparkLanguage } from "./index.ts";

export interface SparkCliDispatcherStrings {
  unknownSubcommand: (subcommand: string, originalArgs: readonly string[]) => string;
  dispatchFailure: (targetLabel: string, detail: string) => string;
  signalExit: (targetLabel: string, signal: string) => string;
  helpText: string;
  targetLabel: (target: "tui" | "daemon") => string;
}

export interface SparkTuiCliStrings {
  helpText: string;
  printRequiresPrompt: string;
  headlessDisplayName: string;
  interactiveDisplayName: string;
  modelCommandDescription: string;
  modelCommandArgumentHint: string;
  noActiveModel: string;
  activeModelSuffix: string;
  noModelsRegistered: string;
  noModelsMatching: (query: string) => string;
  headlessAccepted: string;
  rpcRequiresMessage: (command: string) => string;
  unsupportedRpcCommand: (command: string) => string;
}

const DISPATCHER: Record<SparkLanguage, SparkCliDispatcherStrings> = {
  en: {
    unknownSubcommand: (subcommand, originalArgs) =>
      `Unknown spark subcommand: ${subcommand}\nRun "spark --help" for available subcommands. Use "spark tui ${originalArgs.join(
        " ",
      )}" to send text to the interactive TUI.`,
    dispatchFailure: (targetLabel, detail) => `Unable to dispatch to ${targetLabel}: ${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} exited due to signal ${signal}`,
    helpText:
      'spark - Spark command dispatcher\n\nUsage:\n  spark\n  spark tui [initial message]\n  spark --print <prompt>\n  spark --mode json --print <prompt>\n  spark --mode rpc\n  spark --list-models [search]\n  spark install|remove|update|list|config [resource]\n  spark daemon <command> [args...]\n  spark --help\n  spark --version\n\nDispatches to Spark surfaces:\n  spark tui      interactive terminal UI and Pi-compatible CLI/resource shims\n  spark daemon   daemon administration\n\nUnknown subcommands fail loudly instead of being interpreted as prompts. Use "spark tui ..." for interactive TUI input.\n',
    targetLabel: (target) => (target === "tui" ? "Spark TUI" : "Spark daemon"),
  },
  zh: {
    unknownSubcommand: (subcommand, originalArgs) =>
      `未知 spark 子命令：${subcommand}\n运行 "spark --help" 查看可用子命令。使用 "spark tui ${originalArgs.join(
        " ",
      )}" 将文本发送到交互式 TUI。`,
    dispatchFailure: (targetLabel, detail) => `无法分发到 ${targetLabel}：${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} 因信号 ${signal} 退出`,
    helpText:
      'spark - Spark 命令分发器\n\n用法：\n  spark\n  spark tui [初始消息]\n  spark --print <prompt>\n  spark --mode json --print <prompt>\n  spark --mode rpc\n  spark --list-models [search]\n  spark install|remove|update|list|config [resource]\n  spark daemon <command> [args...]\n  spark --help\n  spark --version\n\n分发到 Spark 界面：\n  spark tui      交互式终端 UI 和 Pi 兼容 CLI/resource shim\n  spark daemon   daemon 管理\n\n未知子命令会直接失败，不会被解释成 prompt。交互式 TUI 输入请使用 "spark tui ..."。\n',
    targetLabel: (target) => (target === "tui" ? "Spark TUI" : "Spark daemon"),
  },
};

const TUI_CLI: Record<SparkLanguage, SparkTuiCliStrings> = {
  en: {
    helpText:
      'spark-tui - Spark terminal UI\n\nUsage:\n  spark-tui [initial message]\n  spark-tui --print <prompt>\n  spark-tui --mode json --print <prompt>\n  spark-tui --mode rpc\n  spark-tui --list-models [search]\n  spark-tui install|remove|update|list|config [resource]\n  spark-tui --help\n\nRuns terminal UI rendering by default, but prompts are submitted to the Spark daemon over local IPC. Pi-compatible resource commands update ~/.spark/config.json and keep extensions/providers/skills/prompt templates/themes explicit. Use the root "spark daemon ..." dispatcher path for daemon administration.',
    printRequiresPrompt: "spark --print requires a prompt",
    headlessDisplayName: "Spark headless submit",
    interactiveDisplayName: "Spark TUI",
    modelCommandDescription: "Switch or inspect the active Spark model",
    modelCommandArgumentHint: "[model-id]",
    noActiveModel: "No Spark model is registered yet.",
    activeModelSuffix: " (active)",
    noModelsRegistered: "No Spark models registered",
    noModelsMatching: (query) => `No Spark models matching ${query}`,
    headlessAccepted: "Spark daemon accepted the headless prompt.",
    rpcRequiresMessage: (command) => `${command} requires message`,
    unsupportedRpcCommand: (command) => `unsupported rpc command: ${command}`,
  },
  zh: {
    helpText:
      'spark-tui - Spark 终端 UI\n\n用法：\n  spark-tui [初始消息]\n  spark-tui --print <prompt>\n  spark-tui --mode json --print <prompt>\n  spark-tui --mode rpc\n  spark-tui --list-models [search]\n  spark-tui install|remove|update|list|config [resource]\n  spark-tui --help\n\n默认运行终端 UI 渲染，但 prompt 会通过本地 IPC 提交给 Spark daemon。Pi 兼容 resource 命令会更新 ~/.spark/config.json，并显式维护 extensions/providers/skills/prompt templates/themes。daemon 管理请使用根命令 "spark daemon ..."。',
    printRequiresPrompt: "spark --print 需要 prompt",
    headlessDisplayName: "Spark headless submit",
    interactiveDisplayName: "Spark TUI",
    modelCommandDescription: "切换或查看当前 Spark 模型",
    modelCommandArgumentHint: "[model-id]",
    noActiveModel: "尚未注册 Spark 模型。",
    activeModelSuffix: "（当前）",
    noModelsRegistered: "尚未注册 Spark 模型",
    noModelsMatching: (query) => `没有匹配 ${query} 的 Spark 模型`,
    headlessAccepted: "Spark daemon 已接受 headless prompt。",
    rpcRequiresMessage: (command) => `${command} 需要 message`,
    unsupportedRpcCommand: (command) => `不支持的 rpc 命令：${command}`,
  },
};

export function sparkCliDispatcherStrings(
  language: SparkLanguage = "en",
): SparkCliDispatcherStrings {
  return DISPATCHER[language];
}

export interface SparkNativeTuiStrings {
  welcome: string;
  stoppedTurn: (reason: string, clearedQueued: number) => string;
  turnFailed: (error: string) => string;
  steeringUpdate: (body: string) => string;
  defaultHelp: string;
  capturedCommand: (input: string) => string;
  capturedIntent: (input: string) => string;
  widgetRenderFailed: (error: string) => string;
  inputPreparationFailed: (error: string) => string;
  noQueuedInputToRestore: string;
  noWorkflowRunSelected: string;
  selectedWorkflowNotLive: (id: string) => string;
  hostCommandNotRegistered: (name: string) => string;
  noInteractionHandler: string;
  builtinCommands: Array<{ name: string; description: string; argumentHint?: string }>;
  keybindings: {
    toggleTools: string;
    toggleThinking: string;
    toggleCockpit: string;
    cycleCockpitPanel: string;
  };
  appTitle: string;
  footer: string;
  toolFolded: (header: string) => string;
  emptyCommand: string;
  unknownCommand: (name: string) => string;
  commandFailed: (name: string, error: string) => string;
  noTurnRunning: string;
  exiting: string;
  cockpitPanelClosed: string;
  cockpitPanelOpen: (panel: string, countsLine: string) => string;
  commandHelp: (registeredCount: number, registeredCommands: string[]) => string;
}

const NATIVE_TUI: Record<SparkLanguage, SparkNativeTuiStrings> = {
  en: {
    welcome:
      "Spark native TUI is running through the Spark pi-tui adapter boundary. Enter queues steering updates while Spark is busy; Alt+Enter queues follow-up turns.",
    stoppedTurn: (reason, clearedQueued) =>
      `Stopped current Spark turn (${reason}).${
        clearedQueued > 0 ? ` Restored ${clearedQueued} queued input(s) to the editor.` : ""
      }`,
    turnFailed: (error) =>
      `Spark turn failed: ${error}. Use /retry to resubmit or /status to inspect the daemon.`,
    steeringUpdate: (body) =>
      `Steering update for the previous Spark turn. Use this to adjust or correct the in-progress response before continuing.\n\n${body}`,
    defaultHelp: [
      "Spark native TUI commands:",
      "- /help: show this help",
      "- /clear: restart the visible transcript by reopening the TUI",
      "- ordinary input is accepted as Spark intent and queued safely while busy",
    ].join("\n"),
    capturedCommand: (input) =>
      `Command '${input}' was captured by the Spark native TUI. Command dispatch will be wired to Spark-owned runtime services here, without the Pi agent SDK runtime.`,
    capturedIntent: (input) =>
      `Captured Spark intent: ${input}\n\nNative Spark agent/runtime wiring will live here on top of pi-tui and Spark packages, not Pi's SDK TUI wrapper.`,
    widgetRenderFailed: (error) => `widget render failed: ${error}`,
    inputPreparationFailed: (error) => `Input preparation failed: ${error}`,
    noQueuedInputToRestore: "No queued input to restore.",
    noWorkflowRunSelected: "No workflow run is selected in the Spark cockpit.",
    selectedWorkflowNotLive: (id) =>
      `Selected workflow ${id} is not a live dynamic workflow runRef. Use /workflow-runs to list dynamic runs.`,
    hostCommandNotRegistered: (name) => `/${name} is not registered in this Spark host.`,
    noInteractionHandler:
      "Spark native TUI received an interaction request but no handler is installed.",
    builtinCommands: [
      { name: "help", description: "show native TUI commands" },
      { name: "clear", description: "clear the visible transcript" },
      {
        name: "stop",
        description: "stop the current Spark turn and clear queued follow-ups",
        argumentHint: "[reason]",
      },
      { name: "retry", description: "resubmit the previous user prompt" },
      {
        name: "cockpit",
        description: "show Spark cockpit panels",
        argumentHint: "[overview|workflows|runs|tasks|artifacts|reviews|graft|off]",
      },
      { name: "workflows", description: "open the workflow cockpit panel" },
      { name: "runs", description: "open the run cockpit panel" },
      { name: "tasks", description: "open the task cockpit panel" },
      { name: "artifacts", description: "open the artifact/evidence cockpit panel" },
      { name: "evidence", description: "open the artifact/evidence cockpit panel" },
      { name: "reviews", description: "open the reviewer verdict cockpit panel" },
      { name: "graft", description: "open the Graft provenance cockpit panel" },
      { name: "exit", description: "exit the native TUI" },
      { name: "quit", description: "exit the native TUI" },
    ],
    keybindings: {
      toggleTools: "Toggle tool output expansion",
      toggleThinking: "Toggle thinking block expansion",
      toggleCockpit: "Toggle the Spark workflow/task/artifact cockpit panel",
      cycleCockpitPanel: "Cycle Spark cockpit workflow/run/task/artifact panels",
    },
    appTitle: "Spark",
    footer: "Enter submit • /help commands • Ctrl+C/Ctrl+D exit",
    toolFolded: (header) => `${header} • folded (Ctrl+O to expand)`,
    emptyCommand: "Empty command. Type /help for available commands.",
    unknownCommand: (name) => `Unknown command: /${name}. Type /help for available commands.`,
    commandFailed: (name, error) => `Command /${name} failed: ${error}`,
    noTurnRunning: "No Spark turn is currently running.",
    exiting: "Exiting Spark native TUI.",
    cockpitPanelClosed: "Spark cockpit panel closed.",
    cockpitPanelOpen: (panel, countsLine) => `Spark cockpit ${panel} panel open.\n${countsLine}`,
    commandHelp: (registeredCount, registeredCommands) =>
      [
        "Spark native TUI commands:",
        `${registeredCount} registered host/daemon command${registeredCount === 1 ? "" : "s"} available.`,
        "/help — show native TUI commands",
        "/clear — clear the visible transcript",
        "/stop [reason] — stop the current Spark turn and restore queued inputs to the editor",
        "/retry — resubmit the previous user prompt",
        "/cockpit [overview|workflows|runs|tasks|artifacts|reviews|graft|off] — show Spark cockpit panels",
        "/workflows, /runs, /tasks, /artifacts, /reviews, /graft — open a focused cockpit panel",
        "Ctrl+K — toggle Spark cockpit overview; Shift+Ctrl+K — cycle cockpit panels",
        "/exit or /quit — exit the native TUI",
        ...registeredCommands,
      ].join("\n"),
  },
  zh: {
    welcome:
      "Spark native TUI 正通过 Spark pi-tui adapter boundary 运行。Spark 忙碌时，Enter 会排队 steering update；Alt+Enter 会排队 follow-up turn。",
    stoppedTurn: (reason, clearedQueued) =>
      `已停止当前 Spark turn（${reason}）。${
        clearedQueued > 0 ? `已将 ${clearedQueued} 条 queued input 恢复到编辑器。` : ""
      }`,
    turnFailed: (error) =>
      `Spark turn 失败：${error}。使用 /retry 重新提交，或用 /status 检查 daemon。`,
    steeringUpdate: (body) =>
      `上一轮 Spark turn 的 steering update。用于在继续前调整或纠正进行中的回复。\n\n${body}`,
    defaultHelp: [
      "Spark native TUI 命令：",
      "- /help：显示此帮助",
      "- /clear：通过重新打开 TUI 重置可见 transcript",
      "- 普通输入会作为 Spark intent 接收；忙碌时会安全排队",
    ].join("\n"),
    capturedCommand: (input) => `命令 '${input}' 已被 Spark native TUI 捕获。`,
    capturedIntent: (input) => `已捕获 Spark intent：${input}`,
    widgetRenderFailed: (error) => `widget 渲染失败：${error}`,
    inputPreparationFailed: (error) => `输入准备失败：${error}`,
    noQueuedInputToRestore: "没有可恢复的 queued input。",
    noWorkflowRunSelected: "Spark cockpit 中尚未选择 workflow run。",
    selectedWorkflowNotLive: (id) => `选中的 workflow ${id} 不是 live dynamic workflow runRef。`,
    hostCommandNotRegistered: (name) => `/${name} 没有在此 Spark host 中注册。`,
    noInteractionHandler: "Spark native TUI 收到 interaction request，但未安装 handler。",
    builtinCommands: [
      { name: "help", description: "显示 native TUI 命令" },
      { name: "clear", description: "清空可见 transcript" },
      {
        name: "stop",
        description: "停止当前 Spark turn 并清空 queued follow-up",
        argumentHint: "[reason]",
      },
      { name: "retry", description: "重新提交上一条用户 prompt" },
      {
        name: "cockpit",
        description: "显示 Spark cockpit panel",
        argumentHint: "[overview|workflows|runs|tasks|artifacts|reviews|graft|off]",
      },
      { name: "workflows", description: "打开 workflow cockpit panel" },
      { name: "runs", description: "打开 run cockpit panel" },
      { name: "tasks", description: "打开 task cockpit panel" },
      { name: "artifacts", description: "打开 artifact/evidence cockpit panel" },
      { name: "evidence", description: "打开 artifact/evidence cockpit panel" },
      { name: "reviews", description: "打开 reviewer verdict cockpit panel" },
      { name: "graft", description: "打开 Graft provenance cockpit panel" },
      { name: "exit", description: "退出 native TUI" },
      { name: "quit", description: "退出 native TUI" },
    ],
    keybindings: {
      toggleTools: "切换 tool output 展开状态",
      toggleThinking: "切换 thinking block 展开状态",
      toggleCockpit: "切换 Spark workflow/task/artifact cockpit panel",
      cycleCockpitPanel: "循环切换 Spark cockpit workflow/run/task/artifact panel",
    },
    appTitle: "Spark",
    footer: "Enter 提交 • /help 命令 • Ctrl+C/Ctrl+D 退出",
    toolFolded: (header) => `${header} • 已折叠（Ctrl+O 展开）`,
    emptyCommand: "空命令。输入 /help 查看可用命令。",
    unknownCommand: (name) => `未知命令：/${name}。输入 /help 查看可用命令。`,
    commandFailed: (name, error) => `命令 /${name} 失败：${error}`,
    noTurnRunning: "当前没有运行中的 Spark turn。",
    exiting: "正在退出 Spark native TUI。",
    cockpitPanelClosed: "Spark cockpit panel 已关闭。",
    cockpitPanelOpen: (panel, countsLine) => `Spark cockpit ${panel} panel 已打开。\n${countsLine}`,
    commandHelp: (registeredCount, registeredCommands) =>
      [
        "Spark native TUI 命令：",
        `可用 host/daemon 注册命令：${registeredCount} 个。`,
        "/help — 显示 native TUI 命令",
        "/clear — 清空可见 transcript",
        "/stop [reason] — 停止当前 Spark turn 并把 queued input 恢复到编辑器",
        "/retry — 重新提交上一条用户 prompt",
        "/cockpit [overview|workflows|runs|tasks|artifacts|reviews|graft|off] — 显示 Spark cockpit panel",
        "/workflows, /runs, /tasks, /artifacts, /reviews, /graft — 打开 focused cockpit panel",
        "Ctrl+K — 切换 Spark cockpit overview；Shift+Ctrl+K — 循环 cockpit panel",
        "/exit 或 /quit — 退出 native TUI",
        ...registeredCommands,
      ].join("\n"),
  },
};

export function sparkTuiCliStrings(language: SparkLanguage = "en"): SparkTuiCliStrings {
  return TUI_CLI[language];
}

export function sparkNativeTuiStrings(language: SparkLanguage = "en"): SparkNativeTuiStrings {
  return NATIVE_TUI[language];
}
