import {
  DependencyError,
  NotFoundError,
  assertRef,
  nowIso,
  stableId,
  type Project,
  type RoleRef,
  type Task,
  type TaskAttribution,
  type TaskCancellation,
  type TaskClaim,
  type TaskClaimKind,
  type TaskCompletionIssue,
  type TaskCompletionReadiness,
  type TaskDependency,
  type TaskPlan,
  type TaskPlanIssue,
  type TaskPlanIssueKind,
  type TaskPlanItem,
  type TaskPlanReadiness,
  type TaskRef,
  type TaskRun,
  type TaskTodo,
  type TaskTodoStatus,
} from "@zendev-lab/pi-extension-api";
import type {
  CreateTaskTodoInput,
  NonConcreteTaskIssue,
  SessionTodoEntry,
  TaskPlanDecisionResult,
  TaskPlanInput,
  TaskTodoOp,
  TaskTodoStoreEntry,
  TaskTodoSummary,
} from "./common.ts";
import { createDefaultProjectRoadmap, normalizeProjectRoadmap } from "./roadmap.ts";

export function independentTodoDisplayKey(todo: SessionTodoEntry): string {
  return `independent:${todo.id ?? stableId(todo.content)}`;
}

export function isActiveSessionTodo(todo: Pick<SessionTodoEntry, "status">): boolean {
  return todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted";
}

export function isDeletedSessionTodo(todo: Pick<SessionTodoEntry, "status">): boolean {
  return todo.status === "deleted";
}

export function applyIndependentTodoOps(
  todos: SessionTodoEntry[],
  ops: TaskTodoOp[],
): SessionTodoEntry[] {
  return applyTodoListOps(todos, ops, {
    createItem: materializeIndependentTodo,
    createNotFoundError: (id, content) =>
      new Error(id ? `todo id not found: ${id}` : `todo item not found: ${content}`),
    isLiveForProgress: (todo) => todo.status !== "deleted" && todo.status !== "cancelled",
  });
}

export function assertAcyclic(dependencies: TaskDependency[]): void {
  const outgoing = new Map<TaskRef, TaskRef[]>();
  for (const dependency of dependencies) {
    const list = outgoing.get(dependency.dependsOn) ?? [];
    list.push(dependency.taskRef);
    outgoing.set(dependency.dependsOn, list);
  }

  const visiting = new Set<TaskRef>();
  const visited = new Set<TaskRef>();

  function visit(ref: TaskRef): void {
    if (visited.has(ref)) return;
    if (visiting.has(ref)) throw new DependencyError(`cyclic task dependency at ${ref}`);
    visiting.add(ref);
    for (const next of outgoing.get(ref) ?? []) visit(next);
    visiting.delete(ref);
    visited.add(ref);
  }

  for (const ref of outgoing.keys()) visit(ref);
}

export function isExpiredClaim(claim: TaskClaim, now: string): boolean {
  const expiresAt = claim.expiresAt?.trim();
  if (!expiresAt) return true;
  return Date.parse(expiresAt) <= Date.parse(now);
}

export function claimExpiresAt(now: string, leaseMs: number): string {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error("task claim leaseMs must be positive");
  return new Date(Date.parse(now) + leaseMs).toISOString();
}

export interface ClaimScope {
  key: string;
  label: string;
}

export function claimScopeForInput(input: {
  kind: TaskClaimKind;
  sessionId?: string;
  runName?: string;
}): ClaimScope {
  return claimScopeForValues(input.kind, input.sessionId, input.runName);
}

export function claimScopeForStoredClaim(claim: TaskClaim): ClaimScope {
  return claimScopeForValues(claim.kind, claim.sessionId, claim.runName);
}

export function claimScopeForValues(
  kind: TaskClaimKind,
  sessionId: string | undefined,
  runName: string | undefined,
): ClaimScope {
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedSessionId) throw new Error(`${kind} task claim sessionId is required`);
  if (kind === "main")
    return {
      key: `main:${normalizedSessionId}`,
      label: `session ${normalizedSessionId}`,
    };
  const normalizedRoleName = runName?.trim();
  if (!normalizedRoleName) throw new Error("role-run task claim runName is required");
  return {
    key: `role-run:${normalizedSessionId}:${normalizedRoleName}`,
    label: `role-run ${normalizedSessionId}/${normalizedRoleName}`,
  };
}

export function normalizeRoleRef(value: RoleRef | undefined): RoleRef | undefined {
  if (!value) return undefined;
  return assertRef(value, "role");
}

export function rejectLegacyRoleFields(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.agentRef !== undefined) throw new Error(`${label} uses legacy agentRef; use roleRef`);
  if (record.agentName !== undefined)
    throw new Error(`${label} uses legacy agentName; use runName`);
}

export function rejectLegacyClaimFields(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.claimedBySession !== undefined)
    throw new Error(`${label} uses legacy claimedBySession; use claim.sessionId`);
}

export function taskNameFromTitle(title: string): string {
  const ascii = slugifyHandle(title);
  return ascii || `task-${stableId(title)}`;
}

function slugifyHandle(value: string): string {
  let output = "";
  let previousDash = false;
  for (const char of value.trim().toLowerCase()) {
    const allowed = (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_";
    if (allowed) {
      output += char;
      previousDash = false;
    } else if (char === "-") {
      if (output && !previousDash) output += "-";
      previousDash = true;
    } else {
      if (output && !previousDash) output += "-";
      previousDash = true;
    }
  }
  return output.endsWith("-") ? output.slice(0, -1) : output;
}

export function assertTaskName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
    throw new Error(`task name must be a simple @name handle: ${name}`);
}

export function uniqueTaskName(preferred: string, existing: Set<string>): string {
  const base = preferred.trim();
  assertTaskName(base);
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function assertUniqueTaskName(tasks: Task[], name: string, exceptTaskRef?: TaskRef): void {
  const conflict = tasks.find((task) => task.ref !== exceptTaskRef && task.name === name);
  if (conflict) throw new Error(`task name already exists in project: ${name}`);
}

export function addTaskLookup(lookup: Map<string, TaskRef>, task: Task): void {
  lookup.set(task.name, task.ref);
  lookup.set(task.title, task.ref);
  lookup.set(task.ref, task.ref);
}

export function taskLookup(tasks: Task[]): Map<string, TaskRef> {
  const lookup = new Map<string, TaskRef>();
  for (const task of tasks) addTaskLookup(lookup, task);
  return lookup;
}

export function normalizeProject(project: Project): Project {
  const now = nowIso();
  const input = project as Project & { intent?: unknown };
  const rawPurpose = typeof project.purpose === "string" ? project.purpose : input.intent;
  return {
    ref: project.ref,
    title: project.title,
    description: project.description,
    purpose: typeof rawPurpose === "string" ? rawPurpose.trim() || undefined : undefined,
    outputLanguage: project.outputLanguage,
    currentTaskRef: project.currentTaskRef,
    roadmap: project.roadmap
      ? normalizeProjectRoadmap(project.roadmap, `project(${project.ref}).roadmap`)
      : createDefaultProjectRoadmap(project.title, project.createdAt ?? now),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function normalizeTask(task: Task): Task {
  rejectLegacyRoleFields(task, "task");
  rejectLegacyClaimFields(task, "task");
  const claim = isUnfinishedTaskStatus(task.status) ? normalizeTaskClaim(task.claim) : undefined;
  return {
    ref: task.ref,
    projectRef: task.projectRef,
    name: task.name ?? taskNameFromTitle(task.title),
    title: task.title,
    description: task.description,
    kind: task.kind,
    status: task.status,
    roleRef: normalizeRoleRef(task.roleRef),
    finishedBy: normalizeTaskAttribution(task.finishedBy),
    cancellation:
      task.status === "cancelled"
        ? (normalizeTaskCancellation(task.cancellation, task.updatedAt ?? task.createdAt) ?? {
            at: task.updatedAt ?? task.createdAt,
          })
        : undefined,
    supersededBy: normalizeTaskRefs(task.supersededBy),
    claim,
    inputArtifacts: task.inputArtifacts,
    outputArtifacts: task.outputArtifacts,
    plan: normalizeTaskPlan(task.plan, task.description, task.title),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function normalizeTaskPlan(
  plan: Partial<TaskPlan> | undefined,
  description: string,
  title: string,
): TaskPlan {
  const objective = plan?.objective?.trim() || description.trim() || title.trim();
  const legacySteps = normalizeStringList(plan?.steps);
  const explicitItems = normalizeTaskPlanItems(plan?.items);
  const legacyStepItems = normalizeTaskPlanItems(legacySteps.map((step) => ({ title: step })));
  const fallbackItemTitle = description.trim() || title.trim();
  const fallbackItems = fallbackItemTitle
    ? normalizeTaskPlanItems([{ title: fallbackItemTitle }])
    : [];
  const items = explicitItems.length
    ? explicitItems
    : legacyStepItems.length
      ? legacyStepItems
      : fallbackItems;
  return {
    objective,
    contextRefs: normalizeStringList(plan?.contextRefs),
    constraints: normalizeStringList(plan?.constraints),
    nonGoals: normalizeStringList(plan?.nonGoals),
    successCriteria: normalizeStringList(plan?.successCriteria),
    evidenceRequired: normalizeStringList(plan?.evidenceRequired),
    ...(items.length ? { items } : {}),
    // Legacy/import-only mirror for old snapshots and callers; active progress truth is items.
    steps: items.map((item) => item.title),
    decompositionRationale: plan?.decompositionRationale?.trim() || undefined,
    riskLevel: normalizeTaskPlanRiskLevel(plan?.riskLevel),
    openQuestions: normalizeStringList(plan?.openQuestions),
    askRefs: normalizeStringList(plan?.askRefs) as TaskPlan["askRefs"],
  };
}

function normalizeTaskPlanItems(
  items: readonly Partial<TaskPlanItem>[] | undefined,
): TaskPlanItem[] {
  const now = nowIso();
  const normalized = (items ?? [])
    .map((item, index) => normalizeTaskPlanItem(item, index, now))
    .filter((item): item is TaskPlanItem => Boolean(item));
  return dedupeTaskPlanItems(normalized);
}

function normalizeTaskPlanItem(
  item: Partial<TaskPlanItem>,
  index: number,
  now: string,
): TaskPlanItem | undefined {
  const title = item.title?.trim() || item.description?.trim();
  if (!title) return undefined;
  return {
    id: item.id?.trim() || `item-${index + 1}`,
    title,
    description: item.description?.trim() || undefined,
    status: normalizeTaskPlanItemStatus(item.status),
    notes: normalizeStringList(item.notes),
    blockedBy: normalizeStringList(item.blockedBy),
    evidenceRefs: normalizeStringList(item.evidenceRefs) as TaskPlanItem["evidenceRefs"],
    createdAt: item.createdAt?.trim() || now,
    updatedAt: item.updatedAt?.trim() || now,
    deletedAt: item.deletedAt?.trim() || undefined,
  };
}

function dedupeTaskPlanItems(items: TaskPlanItem[]): TaskPlanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.id || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTaskPlanItemStatus(value: unknown): TaskPlanItem["status"] {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "deleted"
  )
    return value;
  return "pending";
}

export function collectNonConcreteTaskIssues(
  tasks: readonly TaskPlanInput[],
): NonConcreteTaskIssue[] {
  return tasks.flatMap((task) => {
    const message = nonConcreteTaskMessage(task);
    return message ? [{ name: task.name, title: task.title, message }] : [];
  });
}

export function renderNonConcreteTaskIssues(issues: readonly NonConcreteTaskIssue[]): string {
  return [
    "task_not_concrete: tasks must be concrete executable/review/validation work, not standalone design/planning placeholders.",
    ...issues.map((issue) => `- @${issue.name ?? "unnamed"}: ${issue.title} - ${issue.message}`),
    "Discuss design/architecture decisions with the user first, then embed the chosen design in each concrete task.plan.",
  ].join("\n");
}

export function nonConcreteTaskMessage(task: TaskPlanInput): string | undefined {
  if (task.status === "cancelled" || task.status === "done") return undefined;
  if (task.kind === "plan")
    return "kind=plan is reserved for planning logic; create concrete implement/review/research/validation work and put design details in task.plan";
  const title = task.title.trim();
  if (/^(设计|规划)(\s|[:：]|$)/u.test(title))
    return "title starts with a design/planning verb; discuss the design with the user, then create concrete implementation/review/validation tasks";
  if (/^(design|plan)(\s|[:：-]|$)/iu.test(title))
    return "title starts with a design/planning verb; discuss the design with the user, then create concrete implementation/review/validation tasks";
  return undefined;
}

export interface TaskPlanReadinessRule {
  kind: TaskPlanIssueKind;
  severity: TaskPlanIssue["severity"];
  message: string;
  remediation: string;
  description: string;
}

export const TASK_PLAN_READINESS_RULES: readonly TaskPlanReadinessRule[] = [
  {
    kind: "missing_plan",
    severity: "blocking",
    message: "Task has no bound plan.",
    remediation:
      "Add a concrete plan with objective, success criteria, evidence requirements, and plan items.",
    description: "the task must have a bound plan.",
  },
  {
    kind: "missing_objective",
    severity: "blocking",
    message: "Task plan needs an objective.",
    remediation: "Fill plan.objective with the specific outcome this task should achieve.",
    description: "plan.objective must be non-empty.",
  },
  {
    kind: "missing_success_criteria",
    severity: "blocking",
    message: "Task plan needs success criteria.",
    remediation: "Add at least one observable entry to plan.successCriteria.",
    description: "plan.successCriteria must include at least one observable success criterion.",
  },
  {
    kind: "missing_evidence_required",
    severity: "blocking",
    message: "Task plan needs evidence requirements.",
    remediation:
      "Add at least one concrete validation artifact or command to plan.evidenceRequired.",
    description:
      "plan.evidenceRequired must include at least one concrete evidence item required before completion.",
  },
  {
    kind: "missing_steps",
    severity: "blocking",
    message: "Task plan needs plan items.",
    remediation: "Add at least one concrete plan item to plan.items.",
    description: "plan.items must include at least one concrete progress item.",
  },
  {
    kind: "open_questions",
    severity: "blocking",
    message: "Task plan has unresolved questions.",
    remediation:
      "Resolve material questions with ask, then move decisions into askRefs or the plan body.",
    description:
      "plan.openQuestions must be empty; resolve material questions through context-specific ask artifacts before planning.",
  },
];

export const TASK_PLAN_READINESS_RULE_BY_KIND = new Map(
  TASK_PLAN_READINESS_RULES.map((rule) => [rule.kind, rule]),
);

export function renderTaskPlanReadinessRules(): string {
  const warningOnly = TASK_PLAN_READINESS_RULES.filter((rule) => rule.severity === "warning");
  const severityLine =
    warningOnly.length === 0
      ? "- TaskPlanIssue kinds currently have no warning-only entries; every current kind below is blocking."
      : `- Warning-only TaskPlanIssue kinds: ${warningOnly.map((rule) => rule.kind).join(", ")}.`;
  return [
    severityLine,
    ...TASK_PLAN_READINESS_RULES.map((rule) => `- ${rule.kind}: ${rule.description}`),
  ].join("\n");
}

export function taskPlanReadiness(task: Pick<Task, "plan" | "status">): TaskPlanReadiness {
  if (task.status === "cancelled") return { ready: true, issues: [] };
  const issues: TaskPlanIssue[] = [];
  const plan = task.plan;
  if (!plan) {
    issues.push(taskPlanIssue("missing_plan"));
    return { ready: false, issues };
  }
  if (!plan.objective.trim()) {
    issues.push(taskPlanIssue("missing_objective"));
  }
  if (plan.successCriteria.length === 0) {
    issues.push(taskPlanIssue("missing_success_criteria"));
  }
  if (plan.evidenceRequired.length === 0) {
    issues.push(taskPlanIssue("missing_evidence_required"));
  }
  const activePlanItemCount = (plan.items ?? []).filter((item) => item.status !== "deleted").length;
  if (activePlanItemCount === 0) {
    issues.push(taskPlanIssue("missing_steps"));
  }
  if (plan.openQuestions.length > 0) {
    issues.push(
      taskPlanIssue(
        "open_questions",
        `Task plan has unresolved questions: ${plan.openQuestions.join("; ")}`,
      ),
    );
  }
  return { ready: issues.every((issue) => issue.severity !== "blocking"), issues };
}

export function decideTaskPlanBeforeCreate(task: Task): TaskPlanDecisionResult {
  const readiness = taskPlanReadiness(task);
  const plan = task.plan;
  if (readiness.ready) return { asked: false, accepted: true, blocked: false, plan, issues: [] };
  return {
    asked: false,
    accepted: false,
    blocked: true,
    plan,
    issues: readiness.issues,
    summary: summarizeTaskPlanIssues(task, readiness.issues),
  };
}

export function summarizeTaskPlanIssues(task: Task, issues: TaskPlanIssue[]): string {
  const issueSummary = issues
    .map((issue) => `${issue.message} fix: ${issue.remediation}`)
    .join(" ");
  return `Task @${task.name} "${task.title}" needs a concrete, context-specific plan before creation or update. ${issueSummary}`;
}

export function taskPlanIssue(kind: TaskPlanIssueKind, message?: string): TaskPlanIssue {
  const rule = TASK_PLAN_READINESS_RULE_BY_KIND.get(kind);
  if (!rule) throw new Error(`unknown task plan readiness rule: ${kind}`);
  return {
    kind: rule.kind,
    severity: rule.severity,
    message: message ?? rule.message,
    remediation: rule.remediation,
  };
}

export function taskCompletionReadiness(
  task: Pick<Task, "plan" | "outputArtifacts" | "status">,
): TaskCompletionReadiness {
  if (task.status === "cancelled") return { ready: true, issues: [] };
  const issues: TaskCompletionIssue[] = [];
  const evidenceRequired = task.plan?.evidenceRequired ?? [];
  if (evidenceRequired.length > 0 && task.outputArtifacts.length === 0) {
    issues.push({
      kind: "missing_completion_evidence",
      severity: "blocking",
      evidenceRequired,
      message: `Task completion needs evidence artifacts: ${evidenceRequired.join("; ")}`,
    });
  }
  const openItems = (task.plan?.items ?? []).filter(
    (item) => item.status !== "done" && item.status !== "cancelled" && item.status !== "deleted",
  );
  if (openItems.length > 0) {
    const labels = openItems.slice(0, 5).map((item) => `${item.status}: ${item.title}`);
    issues.push({
      kind: "open_plan_items",
      severity: "blocking",
      openItems: labels,
      message: `Task completion needs all task plan items done or dispositioned; ${openItems.length} still open: ${labels.join("; ")}`,
    });
  }
  return { ready: issues.every((issue) => issue.severity !== "blocking"), issues };
}

export function cloneTaskPlan(plan: TaskPlan): TaskPlan {
  return {
    ...plan,
    contextRefs: [...plan.contextRefs],
    constraints: [...plan.constraints],
    nonGoals: [...plan.nonGoals],
    successCriteria: [...plan.successCriteria],
    evidenceRequired: [...plan.evidenceRequired],
    items: (plan.items ?? []).map((item) => ({
      ...item,
      notes: item.notes ? [...item.notes] : undefined,
      blockedBy: item.blockedBy ? [...item.blockedBy] : undefined,
      evidenceRefs: item.evidenceRefs ? [...item.evidenceRefs] : undefined,
    })),
    steps: [...plan["steps"]],
    openQuestions: [...plan.openQuestions],
    askRefs: [...plan.askRefs],
  };
}

export function normalizeStringList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function normalizeTaskRefs(values: readonly string[] | undefined): TaskRef[] {
  return normalizeStringList(values).map((value) => assertRef(value, "task"));
}

export function normalizeTaskCancellation(
  cancellation: TaskCancellation | undefined,
  fallbackAt: string,
): TaskCancellation | undefined {
  const at = cancellation?.at?.trim() || fallbackAt;
  const by = cancellation?.by?.trim();
  const reason = cancellation?.reason?.trim();
  if (!at && !by && !reason) return undefined;
  return {
    at,
    ...(by ? { by } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function normalizeTaskPlanRiskLevel(value: unknown): TaskPlan["riskLevel"] {
  return value === "trivial" || value === "high" ? value : "normal";
}

export function attributionFromTask(task: Pick<Task, "claim">): TaskAttribution | undefined {
  const sessionId = task.claim?.sessionId;
  const roleRef = task.claim?.kind === "role-run" ? task.claim.roleRef : undefined;
  const runName = task.claim?.kind === "role-run" ? task.claim.runName?.trim() : undefined;
  return normalizeTaskAttribution({ sessionId, roleRef, runName });
}

export function normalizeTaskAttribution(
  attribution: TaskAttribution | undefined,
): TaskAttribution | undefined {
  rejectLegacyRoleFields(attribution, "task attribution");
  const sessionId = attribution?.sessionId?.trim();
  const roleRef = normalizeRoleRef(attribution?.roleRef);
  const runName = attribution?.runName?.trim();
  if (!sessionId && !roleRef && !runName) return undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(roleRef ? { roleRef } : {}),
    ...(runName ? { runName } : {}),
  };
}

export function normalizeTaskClaim(claim: TaskClaim | undefined): TaskClaim | undefined {
  if (!claim?.expiresAt?.trim()) return undefined;
  rejectLegacyRoleFields(claim, "task claim");
  const kind = (claim as { kind?: unknown }).kind;
  if (kind !== "main" && kind !== "role-run")
    throw new Error(`task claim kind must be main or role-run: ${String(kind)}`);
  const roleRef = normalizeRoleRef(claim.roleRef);
  const runName = claim.runName?.trim() || undefined;
  return {
    ...claim,
    kind,
    roleRef,
    runName,
    expiresAt: claim.expiresAt,
  };
}

export interface TodoReducerItem {
  id?: string;
  content: string;
  status: TaskTodoStatus;
  notes?: string[];
  blockedBy?: string[];
  updatedAt?: string;
  deletedAt?: string;
}

export interface TodoReducerOptions<T extends TodoReducerItem> {
  createItem: (content: string, index: number, now: string) => T;
  createNotFoundError: (id: string | undefined, content: string | undefined) => Error;
  isLiveForProgress: (todo: T) => boolean;
}

export function applyTaskTodoOps(
  taskRef: TaskRef,
  todos: TaskTodo[],
  ops: TaskTodoOp[],
): TaskTodo[] {
  return applyTodoListOps(todos, ops, {
    createItem: (content, index, now) => ({
      id: todoIdFromContent(content, index),
      taskRef,
      content,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }),
    createNotFoundError: (id, content) => new NotFoundError(`unknown todo item: ${id ?? content}`),
    isLiveForProgress: (todo) => todo.status !== "deleted",
  });
}

export function applyTodoListOps<T extends TodoReducerItem>(
  todos: T[],
  ops: TaskTodoOp[],
  options: TodoReducerOptions<T>,
): T[] {
  let next = cloneTodoList(todos);
  for (const op of ops) next = applyTodoListOp(next, op, options);
  return normalizeTodoList(next, options.isLiveForProgress);
}

export function applyTodoListOp<T extends TodoReducerItem>(
  todos: T[],
  op: TaskTodoOp,
  options: TodoReducerOptions<T>,
): T[] {
  const now = nowIso();
  switch (op.op) {
    case "init":
      return materializeTodoListItems(op.items, options, now, "todo init items are required");
    case "append": {
      const next = cloneTodoList(todos);
      next.push(
        ...materializeTodoListItems(op.items, options, now, "todo append items are required", next),
      );
      return next;
    }
    case "start": {
      const target = resolveTodoListItem(todos, op, options, "todo item is required for start");
      const next = cloneTodoList(todos);
      for (const todo of next) {
        if (todo.status === "in_progress") {
          todo.status = "pending";
          todo.updatedAt = now;
        }
      }
      const current = next.find((todo) => sameTodoItem(todo, target))!;
      current.status = "in_progress";
      current.updatedAt = now;
      return next;
    }
    case "done":
      return patchTodoListStatus(todos, op, options, "done", now, "todo item is required for done");
    case "upsert_done":
      return upsertTodoListDone(todos, op, options, now);
    case "block":
      return patchTodoListStatus(
        todos,
        op,
        options,
        "blocked",
        now,
        "todo item is required for block",
      );
    case "cancel":
      return patchTodoListStatus(
        todos,
        op,
        options,
        "cancelled",
        now,
        "todo item is required for cancel",
      );
    case "delete":
    case "remove":
      return patchTodoListStatus(
        todos,
        op,
        options,
        "deleted",
        now,
        "todo item is required for delete",
      );
    case "restore":
      return patchTodoListStatus(
        todos,
        op,
        options,
        "pending",
        now,
        "todo item is required for restore",
        true,
      );
    case "note": {
      const target = resolveTodoListItem(todos, op, options, "todo item is required for note");
      const text = op.text?.trimEnd();
      if (!text) throw new Error("todo note text is required");
      const next = cloneTodoList(todos);
      const current = next.find((todo) => sameTodoItem(todo, target))!;
      current.notes = current.notes ? [...current.notes, text] : [text];
      current.updatedAt = now;
      return next;
    }
  }
}

export function materializeTodoListItems<T extends TodoReducerItem>(
  items: string[] | undefined,
  options: Pick<TodoReducerOptions<T>, "createItem">,
  now: string,
  missingMessage: string,
  existing: readonly TodoReducerItem[] = [],
): T[] {
  if (!items?.length) throw new Error(missingMessage);
  const next: T[] = [];
  for (const item of items) {
    const content = item.trim();
    if (!content) throw new Error("todo content is required");
    if (
      existing.some((todo) => todo.content === content) ||
      next.some((todo) => todo.content === content)
    ) {
      throw new Error(`duplicate todo content: ${content}`);
    }
    next.push(options.createItem(content, existing.length + next.length, now));
  }
  return next;
}

export function upsertTodoListDone<T extends TodoReducerItem>(
  todos: T[],
  op: Pick<TaskTodoOp, "id" | "item">,
  options: TodoReducerOptions<T>,
  now: string,
): T[] {
  const content = op.item?.trim();
  if (!content) throw new Error("todo item is required for upsert_done");
  const id = op.id?.trim();
  const target = id
    ? (todos.find((todo) => todo.id === id) ?? todos.find((todo) => todo.content === content))
    : todos.find((todo) => todo.content === content);
  if (target) {
    return cloneTodoList(todos).map((todo) => {
      if (!sameTodoItem(todo, target)) return todo;
      return {
        ...todo,
        status: "done",
        deletedAt: undefined,
        notes: appendTodoNote(todo.notes, `upsert_done marked this TODO done at ${now}`),
        updatedAt: now,
      };
    });
  }
  const created = options.createItem(content, todos.length, now);
  return [
    ...cloneTodoList(todos),
    {
      ...created,
      status: "done",
      notes: [`upsert_done created this TODO as done at ${now}`],
      updatedAt: now,
    },
  ];
}

function appendTodoNote(notes: string[] | undefined, note: string): string[] {
  return notes ? [...notes, note] : [note];
}

export function patchTodoListStatus<T extends TodoReducerItem>(
  todos: T[],
  op: Pick<TaskTodoOp, "id" | "item" | "blockedBy">,
  options: TodoReducerOptions<T>,
  status: TaskTodoStatus,
  now: string,
  missingMessage: string,
  includeDeleted = false,
): T[] {
  const target = resolveTodoListItem(todos, op, options, missingMessage, includeDeleted);
  return cloneTodoList(todos).map((todo) => {
    if (!sameTodoItem(todo, target)) return todo;
    return {
      ...todo,
      status,
      blockedBy: status === "blocked" && op.blockedBy?.length ? [...op.blockedBy] : todo.blockedBy,
      deletedAt: status === "deleted" ? now : undefined,
      updatedAt: now,
    };
  });
}

export function resolveTodoListItem<T extends TodoReducerItem>(
  todos: T[],
  op: Pick<TaskTodoOp, "id" | "item">,
  options: Pick<TodoReducerOptions<T>, "createNotFoundError">,
  missingMessage: string,
  includeDeleted = false,
): T {
  const id = op.id?.trim();
  const content = op.item?.trim();
  if (!id && !content) throw new Error(missingMessage);
  const candidates = includeDeleted ? todos : todos.filter((todo) => todo.status !== "deleted");
  const target = id
    ? candidates.find((todo) => todo.id === id)
    : candidates.find((todo) => todo.content === content);
  if (!target) throw options.createNotFoundError(id, content);
  return target;
}

export function normalizeTodoList<T extends TodoReducerItem>(
  todos: T[],
  isLiveForProgress: (todo: T) => boolean,
): T[] {
  const next = cloneTodoList(todos);
  const live = next.filter(isLiveForProgress);
  const inProgress = live.filter((todo) => todo.status === "in_progress");
  if (inProgress.length > 1) {
    for (const todo of inProgress.slice(1)) {
      todo.status = "pending";
      todo.updatedAt = nowIso();
    }
  }
  if (live.some((todo) => todo.status === "in_progress")) return next;
  const firstPending = live.find((todo) => todo.status === "pending");
  if (firstPending) {
    firstPending.status = "in_progress";
    firstPending.updatedAt = nowIso();
  }
  return next;
}

export function cloneTodoList<T extends TodoReducerItem>(todos: T[]): T[] {
  return todos.map((todo) => ({
    ...todo,
    notes: todo.notes ? [...todo.notes] : undefined,
    blockedBy: todo.blockedBy ? [...todo.blockedBy] : undefined,
  }));
}

export function sameTodoItem(left: TodoReducerItem, right: TodoReducerItem): boolean {
  if (left.id || right.id) return left.id === right.id;
  return left.content === right.content;
}

export function materializeIndependentTodo(
  content: string,
  index: number,
  now: string,
): SessionTodoEntry {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("todo content is required");
  return {
    id: `todo-${stableId(`${trimmed}:${index}`).slice(0, 8)}`,
    content: trimmed,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export function materializeTodos(
  taskRef: TaskRef,
  inputs: CreateTaskTodoInput[],
  now: string,
): TaskTodo[] {
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    const content = input.content.trim();
    if (!content) throw new Error("todo content is required");
    if (seen.has(content)) throw new Error(`duplicate todo content: ${content}`);
    seen.add(content);
    return {
      id: input.id ?? todoIdFromContent(content, index),
      taskRef,
      content,
      status: input.status ?? "pending",
      notes: input.notes?.length ? [...input.notes] : undefined,
      blockedBy: input.blockedBy?.length ? [...input.blockedBy] : undefined,
      createdAt: now,
      updatedAt: now,
    } satisfies TaskTodo;
  });
}

export function taskPlanItemsFromTodos(todos: TaskTodo[]): TaskPlanItem[] {
  return normalizeTaskPlanItems(
    todos.map((todo) => ({
      id: todo.id,
      title: todo.content,
      status: todo.status,
      notes: todo.notes,
      blockedBy: todo.blockedBy,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      deletedAt: todo.deletedAt,
    })),
  );
}

export function taskTodosFromPlanItems(
  taskRef: TaskRef,
  items: readonly TaskPlanItem[],
): TaskTodo[] {
  return cloneTodos(
    items.map((item) => ({
      id: item.id,
      taskRef,
      content: item.title,
      status: item.status,
      notes: item.notes,
      blockedBy: item.blockedBy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt,
    })),
  );
}

export function cloneTask(task: Task): Task {
  return {
    ...task,
    claim: task.claim ? { ...task.claim } : undefined,
    finishedBy: task.finishedBy ? { ...task.finishedBy } : undefined,
    cancellation: task.cancellation ? { ...task.cancellation } : undefined,
    supersededBy: [...task.supersededBy],
    inputArtifacts: [...task.inputArtifacts],
    outputArtifacts: [...task.outputArtifacts],
    plan: task.plan ? cloneTaskPlan(task.plan) : undefined,
  };
}

export function normalizeTaskRun(run: TaskRun): TaskRun {
  rejectLegacyRoleFields(run, "task run");
  return {
    ...run,
    roleRef: normalizeRoleRef(run.roleRef),
    runName: run.runName?.trim() || undefined,
    outputArtifacts: [...run.outputArtifacts],
    completionSummary: run.completionSummary
      ? {
          ...run.completionSummary,
          artifactRefs: [...run.completionSummary.artifactRefs],
        }
      : undefined,
  };
}

export function cloneTaskRun(run: TaskRun): TaskRun {
  return normalizeTaskRun(run);
}

export function cloneTodos(todos: TaskTodo[]): TaskTodo[] {
  return todos.map((todo) => ({
    ...todo,
    notes: todo.notes ? [...todo.notes] : undefined,
    blockedBy: todo.blockedBy ? [...todo.blockedBy] : undefined,
  }));
}

export function isUnfinishedTaskStatus(status: Task["status"]): boolean {
  return status !== "done" && status !== "failed" && status !== "cancelled";
}

export function normalizeTodo(todo: TaskTodoStoreEntry): TaskTodo {
  return {
    ...todo,
    id: todo.id || todoIdFromContent(todo.content, 0),
    notes: todo.notes ? [...todo.notes] : undefined,
    blockedBy: todo.blockedBy ? [...todo.blockedBy] : undefined,
    createdAt: todo.createdAt ?? nowIso(),
    updatedAt: todo.updatedAt ?? todo.createdAt ?? nowIso(),
    deletedAt: todo.deletedAt,
  };
}

export function normalizeTodos(todos: TaskTodo[]): TaskTodo[] {
  return normalizeTodoList(todos, (todo) => todo.status !== "deleted");
}

export function summarizeTodos(todos: TaskTodo[]): TaskTodoSummary {
  return {
    total: todos.filter((todo) => todo.status !== "deleted").length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    done: todos.filter((todo) => todo.status === "done").length,
    blocked: todos.filter((todo) => todo.status === "blocked").length,
    cancelled: todos.filter((todo) => todo.status === "cancelled").length,
    deleted: todos.filter((todo) => todo.status === "deleted").length,
    noteCount: todos.reduce((sum, todo) => sum + (todo.notes?.length ?? 0), 0),
    active: todos.find((todo) => todo.status === "in_progress")?.content,
  };
}

export function todoIdFromContent(content: string, index: number): string {
  return `todo-${stableHash(`${index}:${content}`).slice(0, 12)}`;
}

export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isOpenContextTask(task: Task): boolean {
  return !["done", "failed", "cancelled"].includes(task.status);
}
