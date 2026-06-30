import type { SparkLanguage } from "./index.ts";

export interface SparkCliDispatcherStrings {
  unknownSubcommand: (subcommand: string, originalArgs: readonly string[]) => string;
  dispatchFailure: (targetLabel: string, detail: string) => string;
  signalExit: (targetLabel: string, signal: string) => string;
  helpText: string;
  targetLabel: (target: "tui" | "daemon" | "cockpit") => string;
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
      'spark - Spark command dispatcher\n\nUsage:\n  spark\n  spark tui [initial message]\n  spark --print <prompt>\n  spark --mode json --print <prompt>\n  spark --mode rpc\n  spark --list-models [search]\n  spark install|remove|update|list|config [resource]\n  spark daemon <command> [args...]\n  spark cockpit [command] [args...]\n  spark --help\n  spark --version\n\nDispatches to Spark surfaces:\n  spark tui       interactive terminal UI and Pi-compatible CLI/resource shims\n  spark daemon    daemon administration\n  spark cockpit   local Cockpit web app\n\nUnknown subcommands fail loudly instead of being interpreted as prompts. Use "spark tui ..." for interactive TUI input.\n',
    targetLabel: (target) => {
      switch (target) {
        case "tui":
          return "Spark TUI";
        case "daemon":
          return "Spark daemon";
        case "cockpit":
          return "Spark Cockpit";
      }
    },
  },
  zh: {
    unknownSubcommand: (subcommand, originalArgs) =>
      `未知 spark 子命令：${subcommand}\n运行 "spark --help" 查看可用子命令。使用 "spark tui ${originalArgs.join(
        " ",
      )}" 将文本发送到交互式 TUI。`,
    dispatchFailure: (targetLabel, detail) => `无法分发到 ${targetLabel}：${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} 因信号 ${signal} 退出`,
    helpText:
      'spark - Spark 命令分发器\n\n用法：\n  spark\n  spark tui [初始消息]\n  spark --print <prompt>\n  spark --mode json --print <prompt>\n  spark --mode rpc\n  spark --list-models [search]\n  spark install|remove|update|list|config [resource]\n  spark daemon <command> [args...]\n  spark cockpit [command] [args...]\n  spark --help\n  spark --version\n\n分发到 Spark 界面：\n  spark tui       交互式终端 UI 和 Pi 兼容 CLI/resource shim\n  spark daemon    daemon 管理\n  spark cockpit   本地 Cockpit Web 应用\n\n未知子命令会直接失败，不会被解释成 prompt。交互式 TUI 输入请使用 "spark tui ..."。\n',
    targetLabel: (target) => {
      switch (target) {
        case "tui":
          return "Spark TUI";
        case "daemon":
          return "Spark daemon";
        case "cockpit":
          return "Spark Cockpit";
      }
    },
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

export interface SparkTuiResourceStrings {
  installRequiresSource: string;
  removeRequiresSource: string;
  installedPackage: (kind: string, source: string) => string;
  packageAlreadyInstalled: (kind: string, source: string) => string;
  removedResource: (kind: string, source: string) => string;
  resourceWasNotInstalled: (kind: string, source: string) => string;
  packageNotInstalled: (source: string) => string;
  noPackagesInstalled: (packageRoot: string) => string;
  updatedPackage: (source: string) => string;
  updatedPackages: (count: number) => string;
  configMessage: (configPath: string, packageRoot: string) => string;
  configuredAndInstalled: string;
  noResourcesConfigured: string;
}

export interface SparkTuiPiParityStrings {
  descriptions: Record<string, string>;
  noAssistantMessage: string;
  changelog: string;
  trust: (cwd: string) => string;
  newTranscript: string;
  reload: string;
  settingsUsageThinking: (levels: readonly string[]) => string;
  thinkingLevelSet: (level: string) => string;
  settingsUsageTheme: (themes: readonly string[]) => string;
  themeSet: (themeId: string) => string;
  settingsHeader: string;
  noModelsRegistered: string;
  noExternalUpload: string;
  importUsage: string;
  sessionNameUnset: string;
  nativeSessionHeader: string;
  authStoreUnavailable: string;
  logoutUsageStored: (providers: readonly string[]) => string;
  logoutUsageEmpty: string;
  removedCredential: (provider: string) => string;
  noCredential: (provider: string) => string;
  providerAuthHeader: string;
  storedCredentials: (providers: readonly string[]) => string;
  noStoredCredentials: string;
  noProvidersRegistered: string;
}

export interface SparkDaemonCliStrings {
  submitRequiresSession: string;
  submitRequiresPrompt: string;
  unknownCommand: (command: string) => string;
  unknownSessionsCommand: (command: string) => string;
  sessionsExportRequiresSession: string;
  sessionsReplayRequiresSession: string;
  serviceCommandMustUseServiceRunner: string;
  helpText: string;
  ignoredEmptyPrompt: string;
  queuedSession: (sessionId: string, fileName: string) => string;
  failedFile: (fileName: string) => string;
  completedSession: (sessionId: string, fileName: string) => string;
  nativeCommandDescriptions: {
    status: string;
    queue: string;
    start: string;
  };
  displayName: Record<"interactive" | "headless" | "executor", string>;
  buildServiceFailed: string;
  notReachable: (message: string) => string;
  localRpcFailed: string;
  invalidStreamResponse: string;
  invalidQueueState: (state: string) => string;
}

const RESOURCE_STRINGS: Record<SparkLanguage, SparkTuiResourceStrings> = {
  en: {
    installRequiresSource: "spark install requires a resource source",
    removeRequiresSource: "spark remove requires a resource source",
    installedPackage: (kind, source) => `Installed Spark ${kind} package: ${source}`,
    packageAlreadyInstalled: (kind, source) => `Spark ${kind} package already installed: ${source}`,
    removedResource: (kind, source) => `Removed Spark ${kind} resource: ${source}`,
    resourceWasNotInstalled: (kind, source) =>
      `Spark ${kind} resource was not installed: ${source}`,
    packageNotInstalled: (source) => `Spark package not installed: ${source}`,
    noPackagesInstalled: (packageRoot) => `No Spark packages installed in ${packageRoot}.`,
    updatedPackage: (source) => `Updated Spark package: ${source}`,
    updatedPackages: (count) => `Updated ${count} Spark package${count === 1 ? "" : "s"}.`,
    configMessage: (configPath, packageRoot) =>
      `Spark resource config: ${configPath}\nSpark package root: ${packageRoot}`,
    configuredAndInstalled: "Spark configured and installed resources",
    noResourcesConfigured: "No Spark resources configured or installed.",
  },
  zh: {
    installRequiresSource: "spark install 需要 resource source",
    removeRequiresSource: "spark remove 需要 resource source",
    installedPackage: (kind, source) => `已安装 Spark ${kind} package：${source}`,
    packageAlreadyInstalled: (kind, source) => `Spark ${kind} package 已安装：${source}`,
    removedResource: (kind, source) => `已移除 Spark ${kind} resource：${source}`,
    resourceWasNotInstalled: (kind, source) => `Spark ${kind} resource 未安装：${source}`,
    packageNotInstalled: (source) => `Spark package 未安装：${source}`,
    noPackagesInstalled: (packageRoot) => `${packageRoot} 中没有已安装的 Spark package。`,
    updatedPackage: (source) => `已更新 Spark package：${source}`,
    updatedPackages: (count) => `已更新 ${count} 个 Spark package。`,
    configMessage: (configPath, packageRoot) =>
      `Spark resource config：${configPath}\nSpark package root：${packageRoot}`,
    configuredAndInstalled: "Spark 已配置和已安装 resource",
    noResourcesConfigured: "没有配置或安装 Spark resource。",
  },
};

const PI_PARITY_DESCRIPTIONS = {
  settings: "show Spark settings and provider/session configuration",
  scopedModels: "show models enabled for Spark model selection/cycling",
  export: "export visible Spark transcript or a persisted session",
  import: "import a Spark/Pi JSONL session and show resume guidance",
  share: "write a share-safe local HTML transcript export (no secret upload)",
  copy: "copy/show the last Spark assistant message",
  name: "set or show the current Spark session display name",
  session: "show Spark native session info and transcript stats",
  changelog: "show Spark parity changelog highlights",
  hotkeys: "show all Spark keyboard shortcuts",
  fork: "fork the current visible transcript into a new Spark session record",
  clone: "clone the current visible transcript into a new Spark session record",
  tree: "show persisted session tree or append a branch summary",
  trust: "show Spark project trust status and safe next steps",
  login: "log in to a supported Spark OAuth provider or show auth status",
  logout: "remove a stored Spark OAuth/API credential",
  new: "start a new visible Spark transcript",
  compact: "summarize visible Spark transcript and clear older context",
  resume: "list or preview a persisted Spark session for resume",
  reload: "reload Spark keybindings/settings guidance",
} as const;

const PI_PARITY_STRINGS: Record<SparkLanguage, SparkTuiPiParityStrings> = {
  en: {
    descriptions: PI_PARITY_DESCRIPTIONS,
    noAssistantMessage: "No assistant message to copy yet.",
    changelog: [
      "Spark native TUI parity highlights:",
      "- daemon-first native pi-tui host",
      "- slash autocomplete and /model selection",
      "- native widget factory rendering",
      "- Spark cockpit panels for workflows, runs, tasks, artifacts, reviews, and Graft",
    ].join("\n"),
    trust: (cwd) =>
      `Spark trusts this workspace only through explicit config and tool-approval flows. cwd=${cwd}`,
    newTranscript: "Started a new Spark native transcript.",
    reload:
      "Restart or relaunch the native Spark TUI to reload extensions, providers, skills, prompts, themes, and keybindings from disk.",
    settingsUsageThinking: (levels) => `Usage: /settings set thinking <${levels.join("|")}>`,
    thinkingLevelSet: (level) => `Spark thinking level set for this session: ${level}.`,
    settingsUsageTheme: (themes) =>
      `Usage: /settings set theme <${themes.join("|") || "dark|light"}>`,
    themeSet: (themeId) =>
      `Spark theme set: ${themeId}. Restart or /reload to apply it to the active TUI.`,
    settingsHeader: "Spark settings",
    noModelsRegistered: "No Spark models registered.",
    noExternalUpload:
      "No external upload was performed. Review the file before sharing it outside this machine.",
    importUsage: "Usage: /import <spark-jsonl-session-path>",
    sessionNameUnset: "(unset)",
    nativeSessionHeader: "Spark native session",
    authStoreUnavailable: "Spark auth store is not available in this host.",
    logoutUsageStored: (providers) => `Usage: /logout <provider>. Stored: ${providers.join(", ")}`,
    logoutUsageEmpty: "Usage: /logout <provider>",
    removedCredential: (provider) => `Removed stored Spark credential for ${provider}.`,
    noCredential: (provider) => `No stored Spark credential for ${provider}.`,
    providerAuthHeader: "Spark provider auth",
    storedCredentials: (providers) => `Stored credentials: ${providers.join(", ")}`,
    noStoredCredentials: "Stored credentials: none",
    noProvidersRegistered: "No OAuth-capable Spark providers registered.",
  },
  zh: {
    descriptions: PI_PARITY_DESCRIPTIONS,
    noAssistantMessage: "还没有可复制的 assistant 消息。",
    changelog: [
      "Spark native TUI parity highlights:",
      "- daemon-first native pi-tui host",
      "- slash autocomplete and /model selection",
      "- native widget factory rendering",
      "- Spark cockpit panels for workflows, runs, tasks, artifacts, reviews, and Graft",
    ].join("\n"),
    trust: (cwd) => `Spark 只通过显式 config 和 tool approval 信任此 workspace。cwd=${cwd}`,
    newTranscript: "已开始新的 Spark native transcript。",
    reload:
      "重启或重新打开 native Spark TUI 以从磁盘重新加载 extensions/providers/skills/prompts/themes/keybindings。",
    settingsUsageThinking: (levels) => `用法：/settings set thinking <${levels.join("|")}>`,
    thinkingLevelSet: (level) => `Thinking level 已设为 ${level}。`,
    settingsUsageTheme: (themes) =>
      `用法：/settings set theme <${themes.join("|") || "dark|light"}>`,
    themeSet: (themeId) => `Theme 已设为 ${themeId}。重启 TUI 以重新加载样式。`,
    settingsHeader: "Spark settings",
    noModelsRegistered: "尚未注册 Spark 模型。",
    noExternalUpload: "未执行外部上传。",
    importUsage: "用法：/import <spark-jsonl-session-path>",
    sessionNameUnset: "（未设置）",
    nativeSessionHeader: "Spark native session",
    authStoreUnavailable: "此 host 中 Spark auth store 不可用。",
    logoutUsageStored: (providers) => `用法：/logout <provider>。已存储：${providers.join(", ")}`,
    logoutUsageEmpty: "用法：/logout <provider>",
    removedCredential: (provider) => `已移除 ${provider} 的存储凭据。`,
    noCredential: (provider) => `未找到 ${provider} 的存储凭据。`,
    providerAuthHeader: "Spark provider auth",
    storedCredentials: (providers) => `已存储凭据：${providers.join(", ")}`,
    noStoredCredentials: "已存储凭据：无",
    noProvidersRegistered: "尚未注册支持 OAuth 的 Spark provider。",
  },
};

const DAEMON_HELP_TEXT = `spark daemon - Spark daemon control surface\n\nUsage:\n  spark daemon [--workspace <name>]\n  spark daemon status [--json]\n  spark daemon start [--json]\n  spark daemon stop [--yes]\n  spark daemon restart [--yes]\n  spark daemon logs [--follow] [--lines <n>]\n  spark daemon submit --session <id> --prompt <text> [--reset] [--json]\n  spark daemon queue [--state inbox|processed|failed|all] [--limit <n>] [--json]\n  spark daemon sessions [list] [--json]\n  spark daemon sessions export --session <id|path> [--format jsonl|json|text] [--leaf <entry-id|root>] [--json]\n  spark daemon sessions replay --session <id|path> [--leaf <entry-id|root>] [--json]\n  spark daemon workspace register [path] --server-url <url> --token <token|-> --name <name>\n  spark daemon workspace ls [--json] [--all] [--full]\n  spark daemon workspace show [name] [--json]\n  spark daemon workspace stop <name> [--yes]\n\nSpark CLI never runs an independent queue worker; it starts/wakes the Spark daemon and talks over local IPC.`;

const DAEMON_STRINGS: Record<SparkLanguage, SparkDaemonCliStrings> = {
  en: {
    submitRequiresSession: "spark daemon submit requires --session <id>",
    submitRequiresPrompt: "spark daemon submit requires --prompt <text> or trailing text",
    unknownCommand: (command) => `unknown spark daemon command: ${command}`,
    unknownSessionsCommand: (command) => `unknown spark daemon sessions command: ${command}`,
    sessionsExportRequiresSession: "spark daemon sessions export requires --session <id|path>",
    sessionsReplayRequiresSession: "spark daemon sessions replay requires --session <id|path>",
    serviceCommandMustUseServiceRunner:
      "spark daemon service commands must be run through runSparkDaemonCliCommand",
    helpText: DAEMON_HELP_TEXT,
    ignoredEmptyPrompt: "ignored empty prompt",
    queuedSession: (sessionId, fileName) =>
      `queued for Spark daemon session ${sessionId}: ${fileName}`,
    failedFile: (fileName) => `Spark daemon failed ${fileName}`,
    completedSession: (sessionId, fileName) =>
      `Spark daemon completed session ${sessionId}: ${fileName}`,
    nativeCommandDescriptions: {
      status: "show Spark daemon status",
      queue: "show Spark daemon queue; optional state: inbox, processed, failed, all",
      start: "start or wake the Spark daemon, then show status",
    },
    displayName: {
      interactive: "Spark interactive TUI",
      headless: "Spark headless CLI",
      executor: "Spark executor",
    },
    buildServiceFailed: "Spark daemon CLI service build failed before launch.",
    notReachable: (message) => `Spark daemon is not reachable: ${message}`,
    localRpcFailed: "Spark daemon local RPC request failed",
    invalidStreamResponse: "Spark daemon stream response was not readable.",
    invalidQueueState: (state) => `Invalid daemon queue state: ${state}`,
  },
  zh: {
    submitRequiresSession: "spark daemon submit 需要 --session <id>",
    submitRequiresPrompt: "spark daemon submit 需要 --prompt <text> 或 trailing text",
    unknownCommand: (command) => `未知 spark daemon 命令：${command}`,
    unknownSessionsCommand: (command) => `未知 spark daemon sessions 命令：${command}`,
    sessionsExportRequiresSession: "spark daemon sessions export 需要 --session <id|path>",
    sessionsReplayRequiresSession: "spark daemon sessions replay 需要 --session <id|path>",
    serviceCommandMustUseServiceRunner:
      "spark daemon service 命令必须通过 runSparkDaemonCliCommand 运行",
    helpText: DAEMON_HELP_TEXT,
    ignoredEmptyPrompt: "已忽略空 prompt",
    queuedSession: (sessionId, fileName) =>
      `已排队到 Spark daemon session ${sessionId}：${fileName}`,
    failedFile: (fileName) => `Spark daemon 失败：${fileName}`,
    completedSession: (sessionId, fileName) =>
      `Spark daemon 已完成 session ${sessionId}：${fileName}`,
    nativeCommandDescriptions: {
      status: "显示 Spark daemon 状态",
      queue: "显示 Spark daemon queue；可选 state：inbox、processed、failed、all",
      start: "启动或唤醒 Spark daemon，然后显示状态",
    },
    displayName: {
      interactive: "Spark interactive TUI",
      headless: "Spark headless CLI",
      executor: "Spark executor",
    },
    buildServiceFailed: "Spark daemon CLI service build failed before launch.",
    notReachable: (message) => `Spark daemon 不可达：${message}`,
    localRpcFailed: "Spark daemon local RPC request failed",
    invalidStreamResponse: "Spark daemon stream response was not readable.",
    invalidQueueState: (state) => `Invalid daemon queue state: ${state}`,
  },
};

export function sparkTuiCliStrings(language: SparkLanguage = "en"): SparkTuiCliStrings {
  return TUI_CLI[language];
}

export function sparkNativeTuiStrings(language: SparkLanguage = "en"): SparkNativeTuiStrings {
  return NATIVE_TUI[language];
}

export function sparkTuiResourceStrings(language: SparkLanguage = "en"): SparkTuiResourceStrings {
  return RESOURCE_STRINGS[language];
}

export function sparkTuiPiParityStrings(language: SparkLanguage = "en"): SparkTuiPiParityStrings {
  return PI_PARITY_STRINGS[language];
}

export function sparkDaemonCliStrings(language: SparkLanguage = "en"): SparkDaemonCliStrings {
  return DAEMON_STRINGS[language];
}
