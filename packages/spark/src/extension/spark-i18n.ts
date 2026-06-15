import { detectCopyLanguage, type CopyLanguage } from "pi-extension-api";
import type { TaskGraph } from "pi-tasks";
import type { SparkSessionGoal } from "./spark-session-goals.ts";

type SparkProjectLike = ReturnType<TaskGraph["projects"]>[number];

/**
 * Spark uses the canonical CopyLanguage = "en" | "zh" type. Renderers should
 * resolve the active language by asking sparkLanguageForProject (or
 * sparkLanguageForGoal) so that goal ticks, active-context summaries, slash
 * command notifications, and system prompts all stay aligned with the project
 * the user is actually working on.
 */
export type SparkLanguage = CopyLanguage;
export const DEFAULT_SPARK_LANGUAGE: SparkLanguage = "en";

export interface SparkLanguageContext {
  project?: SparkProjectLike;
  goal?: Pick<SparkSessionGoal, "objective" | "pauseReason" | "completedReason"> | null;
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
    if (goalSamples) return detectCopyLanguage(goalSamples);
  }
  if (input.fallbackText) return detectCopyLanguage(input.fallbackText);
  return input.fallback ?? DEFAULT_SPARK_LANGUAGE;
}

export function normalizeSparkLanguage(value: unknown): SparkLanguage | undefined {
  if (value === "zh" || value === "en") return value;
  return undefined;
}

export interface GoalNotificationStrings {
  active: (objective: string, projectLabel: string) => string;
  continuing: (objective: string, projectLabel: string) => string;
  paused: (objective: string) => string;
  pauseBlocked: (objective: string) => string;
  pauseRetryExhausted: (failure: string) => string;
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
  todoSweepNoneActive: string;
  todoSweepHeader: (count: number) => string;
  todoSweepMore: (hidden: number) => string;
  todoSweepDisposition: string;
  notSetVisible: string;
  pauseLineForeground: string;
}

export interface GoalContextStrings {
  notInitialized: string;
  currentProjectLine: (title: string, status: string) => string;
  unfinishedReadyLine: (unfinished: number, ready: number) => string;
  readyFrontierLine: (titles: string[]) => string;
  noActiveProject: (count: number) => string;
  activeProjectCandidates: (titles: string[]) => string;
  projectStatus: (unfinished: number, ready: number, frontier: string[]) => string;
}

const ACTIVE_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal active",
  zh: "Spark 目标已启动",
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
    pauseRetryExhausted: (failure) => `Spark goal paused after retry budget exhausted: ${failure}`,
    pauseAfterAbort: (failure) =>
      `Spark goal paused after manual abort; resume with /goal when ready: ${failure}`,
    noActiveGoal: "Spark has no active goal; main agent will infer one from the current context.",
    inferDispatched: "Spark goal needs to be set; agent will infer it now.",
    noSessionGoal: "No session goal is set.",
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
    pauseRetryExhausted: (failure) => `Spark 目标在多次失败后已暂停：${failure}`,
    pauseAfterAbort: (failure) => `Spark 目标因手动中止而暂停，准备好后用 /goal 继续：${failure}`,
    noActiveGoal: "Spark 当前没有活动目标；主 agent 会基于当前上下文自行推断。",
    inferDispatched: "需要设置 Spark 目标；agent 现在会自行推断。",
    noSessionGoal: "尚未设置会话级目标。",
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
      "Main session mode decision required: choose exactly one of research, plan, or execute for this tick. Workflow and subagent role are tools, not modes.",
    loopReviewerOwnership:
      "Goal is a meta-mode over research/plan/execute. Use research for investigation (prefer subagent role + main-agent summary), plan for task decomposition, execute for bounded work (prefer workflow tools for parallelizable execution). Goal completion is reviewer-owned; when blocked, resolve the blocking work instead of pausing or weakening the goal.",
    emptyGoalNotSet: "Spark session goal is not set.",
    emptyGoalReadContext:
      "Read the Spark project/task context below and decide a concrete, stable session goal. Default to the substantive project outcome described by the project purpose/description/title; use planning/readiness-only wording only when the user explicitly asked for that scope.",
    emptyGoalWriteHint:
      'Write it with goal({ action: "set", objective: "<one short stable line describing the intended project outcome, not task counts>" }).',
    emptyGoalNoCounts:
      "Do not include task counts or ready-frontier text inside the objective; those are recomputed each tick.",
    todoSweepNoneActive: "Session TODO sweep: no active session TODOs. Continue to the goal work.",
    todoSweepHeader: (count) =>
      `Session TODO sweep: ${count} active session TODO(s) before the first goal tick:`,
    todoSweepMore: (hidden) => `\n- … ${hidden} more active session TODO(s)`,
    todoSweepDisposition:
      'Decide each TODO before doing goal work: finish/cancel/delete via task({ action: "todo_update", scope: "session", ops: [...] }).',
    notSetVisible: "Spark goal needs to be set; agent will infer it now.",
    pauseLineForeground:
      "Spark foreground goal loop runs idle-only ticks; goal completion is reviewer-owned.",
  },
  zh: {
    goalActiveHeader: "Spark 会话目标已激活。",
    currentProject: (title) => `当前项目：${title}`,
    goalLine: (objective) => `目标：${objective}`,
    loopTickHeader: "Spark 前台目标循环节拍。",
    loopModeDecisionContract:
      "必须选择本 tick 的主 session 模式：只能从 research、plan、execute 中选一个。workflow 和 subagent role 是工具，不是模式。",
    loopReviewerOwnership:
      "goal 是覆盖 research/plan/execute 的元模式。research 用于调查（优先 subagent role + 主 agent 汇总），plan 用于任务拆解，execute 用于有边界的执行（适合并行的执行优先 workflow 工具）。目标完成由 reviewer 决定；遇到阻塞时先解决阻塞工作，不要自主暂停或降低目标难度。",
    emptyGoalNotSet: "尚未设置 Spark 会话目标。",
    emptyGoalReadContext:
      "阅读下方 Spark 项目/任务上下文，给出一个具体且稳定的会话目标。默认目标应表达 project purpose/description/title 所描述的实质成果；只有用户明确要求仅规划/仅就绪时才写成 planning-only/readiness-only。",
    emptyGoalWriteHint:
      '用 goal({ action: "set", objective: "<一句稳定短描述，表达预期项目成果，不写任务计数>" }) 写入。',
    emptyGoalNoCounts: "目标里不要写任务计数或 ready 边界等动态信息；这些会在每个节拍重新计算。",
    todoSweepNoneActive: "会话 TODO 巡检：当前没有活动的会话 TODO，继续推进目标工作。",
    todoSweepHeader: (count) => `会话 TODO 巡检：第一个目标节拍前有 ${count} 条活动会话 TODO：`,
    todoSweepMore: (hidden) => `\n- … 还有 ${hidden} 条活动会话 TODO`,
    todoSweepDisposition:
      '在推进目标工作前先处置每一条 TODO：finish/cancel/delete，通过 task({ action: "todo_update", scope: "session", ops: [...] })。',
    notSetVisible: "需要设置 Spark 目标；agent 现在会自行推断。",
    pauseLineForeground: "Spark 前台目标循环只在空闲时触发；目标完成由 reviewer 决定。",
  },
};

const CONTEXTS: Record<SparkLanguage, GoalContextStrings> = {
  en: {
    notInitialized: "Spark project state: not initialized.",
    currentProjectLine: (title, status) => `Current project: ${title} (status=${status}).`,
    unfinishedReadyLine: (unfinished, ready) =>
      `Unfinished tasks: ${unfinished}. Ready tasks: ${ready}.`,
    readyFrontierLine: (titles) => `Ready frontier: ${titles.join("; ")}.`,
    noActiveProject: (count) => `Active project: none. Total projects: ${count}.`,
    activeProjectCandidates: (titles) => `Active project candidates: ${titles.join("; ")}.`,
    projectStatus: (unfinished, ready, frontier) => {
      const tail = frontier.length > 0 ? ` Ready frontier: ${frontier.join("; ")}.` : "";
      return `Project status: unfinished=${unfinished}, ready=${ready}.${tail}`;
    },
  },
  zh: {
    notInitialized: "Spark 项目尚未初始化。",
    currentProjectLine: (title, status) => `当前项目：${title}（状态=${status}）。`,
    unfinishedReadyLine: (unfinished, ready) => `未完成任务：${unfinished}。可执行任务：${ready}。`,
    readyFrontierLine: (titles) => `就绪边界：${titles.join("；")}。`,
    noActiveProject: (count) => `当前没有激活项目，项目总数：${count}。`,
    activeProjectCandidates: (titles) => `候选活跃项目：${titles.join("；")}。`,
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
  independentTodosHeader: (count: number) => string;
  independentTodosHidden: (hidden: number) => string;
  myClaimedTaskLine: (input: {
    status: string;
    name: string;
    title: string;
    ref: string;
    activeTodos: number;
  }) => string;
  myClaimedTodosHidden: (hidden: number) => string;
  hiddenSessionClaimed: (hidden: number) => string;
  projectsCountsLine: (total: number, active: number) => string;
  sparkMdHeader: string;
  sparkMdReadFull: string;
}

const ACTIVE_CONTEXT: Record<SparkLanguage, ActiveSparkContextStrings> = {
  en: {
    header: "Spark context:",
    noProjectHeader: "Spark available: no project selected for this session.",
    noProjectGuidance:
      '- Use task({ action: "project_use" }) to select or create a current project before planning, claiming, or updating project-bound tasks.',
    currentProjectLine: (title, ref) => `- Current project: ${title} (${ref})`,
    taskCountsLine: ({ unfinished, claimed, sessionClaimed, total }) =>
      `- Unfinished tasks: ${unfinished} / claimed: ${claimed} / current_session_claimed: ${sessionClaimed} (${total} total)`,
    goalLine: ({ status, objective, reason }) => {
      const reasonText = reason ? `; reason: ${reason}` : "";
      return `- Session goal: ${status}; ${objective}${reasonText}`;
    },
    independentTodosHeader: (count) => `- Independent TODOs (session priority): ${count} active`,
    independentTodosHidden: (hidden) => `  - … ${hidden} more active TODOs`,
    myClaimedTaskLine: ({ status, name, title, ref, activeTodos }) => {
      const todoSuffix = activeTodos > 0 ? `; ${activeTodos} active TODOs` : "";
      return `- My claimed task: [${status}] @${name}: ${title} (${ref})${todoSuffix}`;
    },
    myClaimedTodosHidden: (hidden) => `  - … ${hidden} more active TODOs`,
    hiddenSessionClaimed: (hidden) =>
      `- … ${hidden} more claimed task(s); use task({ action: "status" }) for details`,
    projectsCountsLine: (total, active) => `- Projects: ${total} total / ${active} active`,
    sparkMdHeader: "SPARK.md (intent excerpt):",
    sparkMdReadFull: "… (read SPARK.md for full intent)",
  },
  zh: {
    header: "Spark 上下文：",
    noProjectHeader: "Spark 可用：当前会话尚未选择项目。",
    noProjectGuidance:
      '- 在规划、认领或更新项目内任务前，先用 task({ action: "project_use" }) 选择或创建当前项目。',
    currentProjectLine: (title, ref) => `- 当前项目：${title}（${ref}）`,
    taskCountsLine: ({ unfinished, claimed, sessionClaimed, total }) =>
      `- 未完成任务：${unfinished} / 已认领：${claimed} / 当前会话已认领：${sessionClaimed}（共 ${total} 条）`,
    goalLine: ({ status, objective, reason }) => {
      const reasonText = reason ? `；原因：${reason}` : "";
      return `- Session 目标：${status}；${objective}${reasonText}`;
    },
    independentTodosHeader: (count) => `- 独立 TODO（会话优先级）：${count} 条活动中`,
    independentTodosHidden: (hidden) => `  - … 还有 ${hidden} 条活动 TODO`,
    myClaimedTaskLine: ({ status, name, title, ref, activeTodos }) => {
      const todoSuffix = activeTodos > 0 ? `；${activeTodos} 条活动 TODO` : "";
      return `- 我认领的任务：[${status}] @${name}：${title}（${ref}）${todoSuffix}`;
    },
    myClaimedTodosHidden: (hidden) => `  - … 还有 ${hidden} 条活动 TODO`,
    hiddenSessionClaimed: (hidden) =>
      `- … 还有 ${hidden} 条已认领任务；用 task({ action: "status" }) 查看详情`,
    projectsCountsLine: (total, active) => `- 项目：${total} 个 / ${active} 个活跃`,
    sparkMdHeader: "SPARK.md（intent 摘录）：",
    sparkMdReadFull: "…（完整 intent 见 SPARK.md）",
  },
};

export function activeSparkContextStrings(language: SparkLanguage): ActiveSparkContextStrings {
  return ACTIVE_CONTEXT[language];
}

export function sparkSystemPromptLanguageDirective(language: SparkLanguage): string {
  if (language === "zh") {
    return "Reply in the language the user is using; project default language: zh.";
  }
  return "Reply in the language the user is using; project default language: en.";
}
