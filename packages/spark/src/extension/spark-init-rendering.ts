import type { CopyLanguage } from "pi-extension-api";
import type { ArtifactRef } from "pi-extension-api";

export interface SparkInitResult {
  cwd: string;
  idea: string;
  projectTitle: string;
  projectRef: string;
  taskCount: number;
  outputLanguage: CopyLanguage;
  status?: string;
  currentTaskRef?: string;
  currentTaskTitle?: string;
  /** Initialization TODOs persisted separately from projects.json. */
  todoSummary: {
    total: number;
    inProgress: number;
    pending: number;
    done: number;
    blocked: number;
    cancelled: number;
  };
  sparkMdPath?: string;
  sparkMdArtifactRef: string;
  rolePlanArtifactRef: string;
  traceRef: string;
  askArtifactRefs: ArtifactRef[];
}

export function renderSparkInitFollowUp(result: SparkInitResult): string {
  const summary = renderSparkInitSummary(result);
  if (result.outputLanguage === "zh") {
    return [
      summary,
      "",
      'Spark 初始化只创建了最小本地状态；不要把自动项目标题当成最终项目命名。先按用户原始意图研究上下文并给出回应：如果阅读真实上下文后发现当前标题只是动作/请求复述，或已有更合适的项目标签，请用 task({ action: "project_update" }) 动态改名。只有在确实需要组织具体可执行工作时才调用 task({ action: "plan" })；不要因为 Spark 刚初始化就创建任务。',
    ].join("\n");
  }
  return [
    summary,
    "",
    'Spark initialization only created minimal local state; do not treat the automatic project title as the final project name. First research the context and respond to the user\'s original intent: if the inspected context shows the current title only repeats an action/request, or a better project label is available, call task({ action: "project_update" }) with that dynamic name. Call task({ action: "plan" }) only when there are concrete executable work items to organize; do not create tasks merely because Spark just initialized.',
  ].join("\n");
}

export function renderSparkInitSummary(result: SparkInitResult): string {
  if (result.outputLanguage === "zh") {
    const lines = [
      "Spark 已初始化：",
      `- 想法：${result.idea}`,
      `- 初始项目标题：${result.projectTitle}`,
      result.sparkMdPath
        ? `- SPARK.md：${result.sparkMdPath}`
        : "- SPARK.md：未物化（intent 已保存为 spark-md artifact）",
      `- Project：${result.projectRef}`,
      `- Tasks：${result.taskCount}`,
      result.currentTaskTitle
        ? `- 当前 task：${result.currentTaskTitle} (${result.currentTaskRef})`
        : "- 当前 task：无",
      `- 当前 TODO：${result.todoSummary.total} total / ${result.todoSummary.inProgress} in_progress / ${result.todoSummary.pending} pending / ${result.todoSummary.done} done`,
      `- SPARK artifact：${result.sparkMdArtifactRef}`,
      `- Role plan artifact：${result.rolePlanArtifactRef}`,
      `- Trace：${result.traceRef}`,
    ];
    for (const askRef of result.askArtifactRefs) lines.push(`- Clarification ask：${askRef}`);
    return lines.join("\n");
  }

  const lines = [
    "Spark initialized:",
    `- Idea: ${result.idea}`,
    `- Initial project title: ${result.projectTitle}`,
    result.sparkMdPath
      ? `- SPARK.md: ${result.sparkMdPath}`
      : "- SPARK.md: not materialized (intent saved as spark-md artifact)",
    `- Project: ${result.projectRef}`,
    `- Tasks: ${result.taskCount}`,
    result.currentTaskTitle
      ? `- Current task: ${result.currentTaskTitle} (${result.currentTaskRef})`
      : "- Current task: none",
    `- Current TODOs: ${result.todoSummary.total} total / ${result.todoSummary.inProgress} in_progress / ${result.todoSummary.pending} pending / ${result.todoSummary.done} done`,
    `- SPARK artifact: ${result.sparkMdArtifactRef}`,
    `- Role plan artifact: ${result.rolePlanArtifactRef}`,
    `- Trace: ${result.traceRef}`,
  ];
  for (const askRef of result.askArtifactRefs) lines.push(`- Clarification ask: ${askRef}`);
  return lines.join("\n");
}

export function renderRolePlan(input: {
  idea: string;
  tasks: Array<{
    title: string;
    description: string;
    kind?: string;
    roleRef?: string;
  }>;
}): string {
  const lines = ["# Initial Role Plan", "", `Idea: ${input.idea}`, "", "## Tasks", ""];
  for (const task of input.tasks) {
    lines.push(`- **${task.title}**`);
    lines.push(`  - Kind: ${task.kind ?? "generic"}`);
    lines.push(`  - Role: ${task.roleRef ?? "unbound"}`);
    lines.push(`  - Instruction: ${task.description}`);
  }
  return `${lines.join("\n")}\n`;
}
