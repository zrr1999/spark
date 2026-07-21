import {
  detectSparkLanguage,
  languageToLocale,
  message,
  normalizeSparkLanguage as normalizeSharedSparkLanguage,
  type SparkLanguage,
} from "./index.ts";

export type { SparkLanguage } from "./index.ts";

export interface SparkProjectLike {
  outputLanguage?: unknown;
}

export interface SparkGoalLike {
  objective: string;
  pauseReason?: string | null;
  completedReason?: string | null;
}

/**
 * Spark uses the canonical CopyLanguage = "en" | "zh" type. Renderers should
 * resolve the active language by asking sparkLanguageForProject (or
 * sparkLanguageForGoal) so that goal ticks, active-context summaries, slash
 * command notifications, and system prompts all stay aligned with the project
 * the user is actually working on.
 */
export const DEFAULT_SPARK_LANGUAGE: SparkLanguage = "en";

export interface SparkLanguageContext {
  project?: SparkProjectLike;
  goal?: SparkGoalLike | null;
  fallbackText?: string;
  fallback?: SparkLanguage;
}

/**
 * Pick the rendering language for any Spark surface tied to a specific
 * project. Project metadata wins when present; otherwise we re-use any goal
 * text and finally fall back to detecting Chinese characters in the supplied
 * fallback. The default is English.
 */
export function sparkLanguageForProject(input: SparkLanguageContext): SparkLanguage {
  const projectLanguage = normalizeSparkLanguage(input.project?.outputLanguage);
  if (projectLanguage) return projectLanguage;
  if (input.goal) {
    const goalSamples = [
      input.goal.objective,
      input.goal.pauseReason ?? "",
      input.goal.completedReason ?? "",
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    if (goalSamples) return detectSparkLanguage(goalSamples);
  }
  if (input.fallbackText) return detectSparkLanguage(input.fallbackText);
  return input.fallback ?? DEFAULT_SPARK_LANGUAGE;
}

export function normalizeSparkLanguage(value: unknown): SparkLanguage | undefined {
  return normalizeSharedSparkLanguage(value);
}

export interface GoalNotificationStrings {
  active: (objective: string, projectLabel: string) => string;
  continuing: (objective: string, projectLabel: string) => string;
  paused: (objective: string) => string;
  pauseBlocked: (objective: string) => string;
  pauseAfterAbort: (failure: string) => string;
  noActiveGoal: string;
  inferDispatched: string;
  noSessionGoal: string;
  staleClearedFor: (projectTitle: string) => string;
  staleReplaced: string;
  goalContinuingHeader: (objective: string, projectLabel: string) => string;
  goalActiveHeader: (objective: string, projectLabel: string) => string;
  goalTickHeader: (objective: string, projectLabel: string) => string;
}

export interface GoalInstructionStrings {
  goalActiveHeader: string;
  currentProject: (projectTitle: string) => string;
  goalLine: (objective: string) => string;
  loopTickHeader: string;
  loopModeDecisionContract: string;
  loopReviewerOwnership: string;
  emptyGoalNotSet: string;
  emptyGoalReadContext: string;
  emptyGoalWriteHint: string;
  emptyGoalNoCounts: string;
  notSetVisible: string;
  pauseLineForeground: string;
}

export interface GoalContextStrings {
  notInitialized: string;
  currentProjectLine: (title: string) => string;
  unfinishedReadyLine: (unfinished: number, ready: number) => string;
  readyFrontierLine: (titles: string[]) => string;
  noActiveProject: (count: number) => string;
  activeProjectCandidates: (titles: string[]) => string;
  projectStatus: (unfinished: number, ready: number, frontier: string[]) => string;
}

const ACTIVE_LABEL: Record<SparkLanguage, string> = {
  en: message("goal_active", languageToLocale("en")),
  zh: message("goal_active", languageToLocale("zh")),
};

const CONTINUING_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal continuing",
  zh: "Spark 目标继续推进",
};

const PAUSED_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal paused",
  zh: "Spark 目标已暂停",
};

const PAUSE_BLOCKED_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal pause blocked by reviewer",
  zh: "Spark 目标暂停被 reviewer 拒绝",
};

const TICK_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal tick",
  zh: "Spark 目标节拍",
};

const NOTIFICATIONS: Record<SparkLanguage, GoalNotificationStrings> = {
  en: {
    active: (objective, label) => `${ACTIVE_LABEL.en}${label} · goal: ${objective}`,
    continuing: (objective, label) => `${CONTINUING_LABEL.en}${label} · ${objective}`,
    paused: (objective) => `${PAUSED_LABEL.en} · goal: ${objective}`,
    pauseBlocked: (objective) => `${PAUSE_BLOCKED_LABEL.en} · goal: ${objective}`,
    pauseAfterAbort: (failure) =>
      `Spark goal paused after manual abort; resume with /goal when ready: ${failure}`,
    noActiveGoal: "Spark has no active goal; main agent will infer one from the current context.",
    inferDispatched: "Spark goal needs to be set; agent will infer it now.",
    noSessionGoal: message("goal_not_set", languageToLocale("en")),
    staleClearedFor: (title) => `Cleared stale Spark goal for completed project: ${title}`,
    staleReplaced: "Spark goal replaced a stale completed-project goal with the new objective.",
    goalContinuingHeader: (objective, label) => `${CONTINUING_LABEL.en}${label} · ${objective}`,
    goalActiveHeader: (objective, label) => `${ACTIVE_LABEL.en}${label} · goal: ${objective}`,
    goalTickHeader: (objective, label) => `${TICK_LABEL.en}${label} · goal: ${objective}`,
  },
  zh: {
    active: (objective, label) => `${ACTIVE_LABEL.zh}${label} · 目标：${objective}`,
    continuing: (objective, label) => `${CONTINUING_LABEL.zh}${label} · ${objective}`,
    paused: (objective) => `${PAUSED_LABEL.zh} · 目标：${objective}`,
    pauseBlocked: (objective) => `${PAUSE_BLOCKED_LABEL.zh} · 目标：${objective}`,
    pauseAfterAbort: (failure) => `Spark 目标因手动中止而暂停，准备好后用 /goal 继续：${failure}`,
    noActiveGoal: "Spark 当前没有活动目标；主 agent 会基于当前上下文自行推断。",
    inferDispatched: "需要设置 Spark 目标；agent 现在会自行推断。",
    noSessionGoal: message("goal_not_set", languageToLocale("zh")),
    staleClearedFor: (title) => `清理已完成项目的过期 Spark 目标：${title}`,
    staleReplaced: "Spark 目标已用新目标替换原先与已完成项目绑定的过期目标。",
    goalContinuingHeader: (objective, label) => `${CONTINUING_LABEL.zh}${label} · ${objective}`,
    goalActiveHeader: (objective, label) => `${ACTIVE_LABEL.zh}${label} · 目标：${objective}`,
    goalTickHeader: (objective, label) => `${TICK_LABEL.zh}${label} · 目标：${objective}`,
  },
};

const INSTRUCTIONS: Record<SparkLanguage, GoalInstructionStrings> = {
  en: {
    goalActiveHeader: "Spark session goal is active.",
    currentProject: (title) => `Current project: ${title}`,
    goalLine: (objective) => `Goal: ${objective}`,
    loopTickHeader: "Spark foreground goal loop tick.",
    loopModeDecisionContract:
      "Goal driver requirements: use the objective, current project/task state, blockers, and validation needs to choose concrete next actions; do not classify the whole tick as plan or implement. Use workflow, subagent role, and role-run only as tools inside the goal driver boundary.",
    loopReviewerOwnership:
      "Goal supplies the objective, idle tick cadence, and reviewer-gated completion flow: the main session requests completion, the reviewer audits, and Spark applies the approved state transition. When blocked, resolve the blocking work instead of pausing or weakening the goal.",
    emptyGoalNotSet: "Spark session goal is not set.",
    emptyGoalReadContext:
      "Read the Spark project/task context below and decide a concrete, stable session goal. Default to the substantive project outcome described by the project purpose/description/title; use planning/readiness-only wording only when the user explicitly asked for that scope.",
    emptyGoalWriteHint:
      'Write it with goal({ action: "set", objective: "<one short stable line describing the intended project outcome, not task counts>" }).',
    emptyGoalNoCounts:
      "Do not include task counts or ready-frontier text inside the objective; those are recomputed each tick.",
    notSetVisible: "Spark goal needs to be set; agent will infer it now.",
    pauseLineForeground:
      "Spark foreground goal loop runs idle-only ticks; goal completion is reviewer-gated.",
  },
  zh: {
    goalActiveHeader: "Spark 会话目标已激活。",
    currentProject: (title) => `当前项目：${title}`,
    goalLine: (objective) => `目标：${objective}`,
    loopTickHeader: "Spark 前台目标循环节拍。",
    loopModeDecisionContract:
      "Goal driver requirements：基于目标、当前项目/任务状态、阻塞与验证需求选择具体下一步；不要把整个 tick 归类为 plan 或 implement。workflow、subagent role、role-run 只作为 goal driver 边界内的工具使用。",
    loopReviewerOwnership:
      "goal 提供目标、空闲节拍循环与 reviewer-gated completion 流程：主 session 发起完成请求，reviewer 审核裁决，Spark 应用通过后的状态转换。遇到阻塞时先解决阻塞工作，不要自主暂停或降低目标难度。",
    emptyGoalNotSet: "尚未设置 Spark 会话目标。",
    emptyGoalReadContext:
      "阅读下方 Spark 项目/任务上下文，给出一个具体且稳定的会话目标。默认目标应表达 project purpose/description/title 所描述的实质成果；只有用户明确要求仅规划/仅就绪时才写成 planning-only/readiness-only。",
    emptyGoalWriteHint:
      '用 goal({ action: "set", objective: "<一句稳定短描述，表达预期项目成果，不写任务计数>" }) 写入。',
    emptyGoalNoCounts: "目标里不要写任务计数或 ready 边界等动态信息；这些会在每个节拍重新计算。",
    notSetVisible: "需要设置 Spark 目标；agent 现在会自行推断。",
    pauseLineForeground: "Spark 前台目标循环只在空闲时触发；目标 completion 是 reviewer-gated。",
  },
};

const CONTEXTS: Record<SparkLanguage, GoalContextStrings> = {
  en: {
    notInitialized: "Spark project state: not initialized.",
    currentProjectLine: (title) => `Current project: ${title}.`,
    unfinishedReadyLine: (unfinished, ready) =>
      `Unfinished tasks: ${unfinished}. Ready tasks: ${ready}.`,
    readyFrontierLine: (titles) => `Ready frontier: ${titles.join("; ")}.`,
    noActiveProject: (count) => `Current project: none. Total projects: ${count}.`,
    activeProjectCandidates: (titles) => `Project candidates: ${titles.join("; ")}.`,
    projectStatus: (unfinished, ready, frontier) => {
      const tail = frontier.length > 0 ? ` Ready frontier: ${frontier.join("; ")}.` : "";
      return `Project status: unfinished=${unfinished}, ready=${ready}.${tail}`;
    },
  },
  zh: {
    notInitialized: "Spark 项目尚未初始化。",
    currentProjectLine: (title) => `当前项目：${title}。`,
    unfinishedReadyLine: (unfinished, ready) => `未完成任务：${unfinished}。可执行任务：${ready}。`,
    readyFrontierLine: (titles) => `就绪边界：${titles.join("；")}。`,
    noActiveProject: (count) => `当前没有选择项目，项目总数：${count}。`,
    activeProjectCandidates: (titles) => `候选项目：${titles.join("；")}。`,
    projectStatus: (unfinished, ready, frontier) => {
      const tail = frontier.length > 0 ? ` 就绪边界：${frontier.join("；")}。` : "";
      return `项目状态：unfinished=${unfinished}, ready=${ready}。${tail}`;
    },
  },
};

export function goalNotifications(language: SparkLanguage): GoalNotificationStrings {
  return NOTIFICATIONS[language];
}

export function goalInstructions(language: SparkLanguage): GoalInstructionStrings {
  return INSTRUCTIONS[language];
}

export function goalContextStrings(language: SparkLanguage): GoalContextStrings {
  return CONTEXTS[language];
}

export interface ActiveSparkContextStrings {
  header: string;
  noProjectHeader: string;
  noProjectGuidance: string;
  currentProjectLine: (title: string, ref: string) => string;
  taskCountsLine: (input: {
    unfinished: number;
    claimed: number;
    sessionClaimed: number;
    total: number;
  }) => string;
  goalLine: (input: { status: string; objective: string; reason?: string }) => string;
  myClaimedTaskLine: (input: {
    status: string;
    name: string;
    title: string;
    ref: string;
    activeTodos: number;
  }) => string;
  myClaimedTodosHidden: (hidden: number) => string;
  hiddenSessionClaimed: (hidden: number) => string;
  projectsCountsLine: (total: number) => string;
  durableStateHint: string;
  sparkMdHeader: string;
  sparkMdReadFull: string;
}

const ACTIVE_CONTEXT: Record<SparkLanguage, ActiveSparkContextStrings> = {
  en: {
    header: "Spark context:",
    noProjectHeader: "Spark available: no project selected for this session.",
    noProjectGuidance:
      '- Use task_write({ action: "project_use" }) to select or create a current project before planning, claiming, or updating project-bound tasks.',
    currentProjectLine: (title, ref) => `- Current project: ${title} (${ref})`,
    taskCountsLine: ({ unfinished, claimed, sessionClaimed, total }) =>
      `- Unfinished tasks: ${unfinished} / claimed: ${claimed} / current_session_claimed: ${sessionClaimed} (${total} total)`,
    goalLine: ({ status, objective, reason }) => {
      const reasonText = reason ? `; reason: ${reason}` : "";
      return `- Session goal: ${status}; ${objective}${reasonText}`;
    },
    myClaimedTaskLine: ({ status, name, title, ref, activeTodos }) => {
      const todoSuffix = activeTodos > 0 ? `; ${activeTodos} active TODOs` : "";
      return `- My claimed task: [${status}] @${name}: ${title} (${ref})${todoSuffix}`;
    },
    myClaimedTodosHidden: (hidden) => `  - … ${hidden} more active TODOs`,
    hiddenSessionClaimed: (hidden) =>
      `- … ${hidden} more claimed task(s); use task_read({ action: "project_status" }) for details`,
    projectsCountsLine: (total) => `- Projects: ${total} total`,
    durableStateHint:
      '- Durable state is authoritative; compact summaries/history are hints. Verify with task_read({ action: "project_status" }) or task_read({ action: "workspace_status" }) before changing project/task/goal state.',
    sparkMdHeader: "SPARK.md (intent excerpt):",
    sparkMdReadFull: "… (read SPARK.md for full intent)",
  },
  zh: {
    header: "Spark 上下文：",
    noProjectHeader: "Spark 可用：当前会话尚未选择项目。",
    noProjectGuidance:
      '- 在规划、认领或更新项目内任务前，先用 task_write({ action: "project_use" }) 选择或创建当前项目。',
    currentProjectLine: (title, ref) => `- 当前项目：${title}（${ref}）`,
    taskCountsLine: ({ unfinished, claimed, sessionClaimed, total }) =>
      `- 未完成任务：${unfinished} / 已认领：${claimed} / 当前会话已认领：${sessionClaimed}（共 ${total} 条）`,
    goalLine: ({ status, objective, reason }) => {
      const reasonText = reason ? `；原因：${reason}` : "";
      return `- Session 目标：${status}；${objective}${reasonText}`;
    },
    myClaimedTaskLine: ({ status, name, title, ref, activeTodos }) => {
      const todoSuffix = activeTodos > 0 ? `；${activeTodos} 条活动 TODO` : "";
      return `- 我认领的任务：[${status}] @${name}：${title}（${ref}）${todoSuffix}`;
    },
    myClaimedTodosHidden: (hidden) => `  - … 还有 ${hidden} 条活动 TODO`,
    hiddenSessionClaimed: (hidden) =>
      `- … 还有 ${hidden} 条已认领任务；用 task_read({ action: "project_status" }) 查看详情`,
    projectsCountsLine: (total) => `- 项目：${total} 个`,
    durableStateHint:
      '- durable state 是权威；compact summary/历史记录只是线索。修改项目/任务/goal 前，先用 task_read({ action: "project_status" }) 或 task_read({ action: "workspace_status" }) 核对。',
    sparkMdHeader: "SPARK.md（intent 摘录）：",
    sparkMdReadFull: "…（完整 intent 见 SPARK.md）",
  },
};

export function activeSparkContextStrings(language: SparkLanguage): ActiveSparkContextStrings {
  return ACTIVE_CONTEXT[language];
}

export interface SparkExtensionToolCopy {
  label?: string;
  description: string;
  promptGuidelines?: string[];
}

const SPARK_EXTENSION_TOOL_COPY: Record<string, Partial<SparkExtensionToolCopy>> = {
  impl_ask: {
    label: "Spark Ask",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock form and persist the answer as an artifact.",
  },
  impl_ask_replay: { label: "Spark Ask Replay" },
  drive: { label: "Spark Drive" },
  goal: { label: "Spark Goal" },
  loop: { label: "Spark Loop" },
  workflow_run: {
    label: "Workflow Run",
    description:
      "Execute a generated or saved JavaScript workflow through Spark workflow runtime primitives. Use for explicit dynamic workflow/fan-out requests after the script has metadata and clear stages.",
  },
  impl_workflow_runs: { label: "Spark Workflow Runs" },
  impl_status: { label: "Spark Status" },
  impl_state: { label: "Spark State" },
  impl_claim_task: { label: "Spark Claim Task" },
  impl_plan_tasks: { label: "Spark Plan Tasks" },
  impl_finish_task: { label: "Spark Finish Task" },
  impl_todo: { label: "Spark Session TODOs" },
  impl_update_task_plan_items: { label: "Spark Update Task plan items" },
  impl_run_ready_tasks: { label: "Spark Run Ready Tasks" },
  impl_recover_task_claim: { label: "Spark Recover Task Claim" },
  impl_list_projects: { label: "Spark List Projects" },
  impl_project_mutation: { label: "Spark Project Mutation" },
  impl_use_project: { label: "Spark Use Project" },
};

export function sparkExtensionToolCopy(
  toolName: string,
  fallback: SparkExtensionToolCopy,
): SparkExtensionToolCopy {
  const override = SPARK_EXTENSION_TOOL_COPY[toolName];
  return {
    ...fallback,
    ...override,
    promptGuidelines: override?.promptGuidelines ?? fallback.promptGuidelines,
  };
}

export interface SparkToolOperationalNotes {
  atomic: string;
  idempotent: string;
  prerequisites: string[];
}

const DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES: SparkToolOperationalNotes = {
  atomic: "read-only",
  idempotent: "yes; repeated calls only re-read current Spark state",
  prerequisites: ["Spark state exists in the current workspace."],
};

export function withSparkToolOperationalNotes(_toolName: string, description: string): string {
  const notes = DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES;
  return [
    description.trimEnd(),
    "",
    `Atomic: ${notes.atomic}`,
    `Idempotent: ${notes.idempotent}`,
    "Prerequisites:",
    ...notes.prerequisites.map((item) => `- ${item}`),
  ].join("\n");
}

export const sparkExtensionContextProviderStrings = {
  label: "Spark context",
  description: "Bounded Spark project/task/TODO/SPARK.md context.",
} as const;

export function sparkSystemPromptLanguageDirective(language: SparkLanguage): string {
  if (language === "zh") {
    return "Reply in the language the user is using; project default language: zh.";
  }
  return "Reply in the language the user is using; project default language: en.";
}
