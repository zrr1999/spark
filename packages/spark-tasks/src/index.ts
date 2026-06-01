import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DependencyError,
  NotFoundError,
  assertRef,
  formatJsonFile,
  isFileNotFoundError,
  parseJsonFileText,
  readJsonFileOptional,
  type RoleRef,
  type ArtifactRef,
  type RunRef,
  type Task,
  type TaskCancellation,
  type TaskCompletionIssue,
  type TaskCompletionReadiness,
  type TaskDependency,
  type TaskAttribution,
  type TaskClaim,
  type TaskClaimKind,
  type TaskKind,
  type TaskPlan,
  type TaskPlanIssue,
  type TaskPlanIssueKind,
  type TaskPlanReadiness,
  type TaskProposal,
  type TaskRef,
  type TaskRun,
  type TaskTodo,
  type TaskTodoStatus,
  type Project,
  type ProjectRef,
  type ProjectStatus,
  newRef,
  nowIso,
  stableId,
  writeJsonFileAtomic,
} from "spark-core";

export interface CreateProjectInput {
  title: string;
  description: string;
  status?: ProjectStatus;
  outputLanguage?: "zh" | "en";
}

export interface CreateTaskTodoInput {
  id?: string;
  content: string;
  status?: TaskTodoStatus;
  notes?: string[];
  blockedBy?: string[];
}

export interface CreateTaskInput {
  projectRef: ProjectRef;
  /** Simple handle used as @name in Pi TUI and tool references. */
  name?: string;
  title: string;
  description: string;
  kind?: TaskKind;
  status?: Task["status"];
  roleRef?: RoleRef;
  finishedBy?: TaskAttribution;
  cancellation?: TaskCancellation;
  supersededBy?: TaskRef[];
  claim?: TaskClaim;
  inputArtifacts?: ArtifactRef[];
  plan?: TaskPlan;
  /**
   * Seed durable TODOs for this task. TaskGraphStore intentionally keeps TODOs
   * out of projects.json; persist them through TaskTodoStore.
   */
  todos?: CreateTaskTodoInput[];
}

export interface ClaimTaskInput {
  kind: TaskClaimKind;
  claimedBy: string;
  roleRef?: RoleRef;
  runName?: string;
  sessionId?: string;
  runRef?: RunRef;
  leaseMs: number;
  now?: string;
}

export interface HeartbeatTaskClaimInput {
  claimedBy: string;
  leaseMs: number;
  now?: string;
}

export interface TaskTodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  blocked: number;
  cancelled: number;
  deleted: number;
  noteCount: number;
  active?: string;
}

export interface ProjectTodoSummary extends TaskTodoSummary {
  tasksWithTodos: number;
}

export interface TaskTodoOp {
  op:
    | "init"
    | "append"
    | "start"
    | "done"
    | "block"
    | "cancel"
    | "delete"
    | "restore"
    | "remove"
    | "note";
  id?: string;
  item?: string;
  items?: string[];
  text?: string;
  blockedBy?: string[];
}

export type SessionTodoStatus = TaskTodoStatus;

export interface SessionTodoEntry {
  id?: string;
  /** Permanent display number within the Pi session; not a row-position ordinal. */
  displayNumber?: number;
  content: string;
  status: SessionTodoStatus;
  notes?: string[];
  blockedBy?: string[];
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
}

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

export interface TaskGraphSnapshot {
  projects: Project[];
  tasks: Task[];
  dependencies: TaskDependency[];
  runs: TaskRun[];
}

export interface TaskPlanInput {
  /** Stable simple handle for @name references. Defaults from title. */
  name?: string;
  title: string;
  description: string;
  kind?: TaskKind;
  status?: Task["status"];
  roleRef?: RoleRef;
  supersededBy?: TaskRef[];
  dependsOn?: Array<TaskRef | string>;
  rationale?: string;
  plan?: TaskPlan;
}

export interface TaskPlanResult {
  created: Task[];
  updated: Task[];
  skipped: Task[];
  dependencies: TaskDependency[];
}

export interface NonConcreteTaskIssue {
  name?: string;
  title: string;
  message: string;
}

export interface TaskPlanDecisionResult {
  asked: false;
  accepted: boolean;
  blocked: boolean;
  plan?: TaskPlan;
  issues: TaskPlanIssue[];
  summary?: string;
}

export interface TaskTodoStoreSnapshot {
  version: 1;
  todos: TaskTodo[];
}

type TaskTodoStoreEntry = Pick<TaskTodo, "taskRef" | "content" | "status"> & Partial<TaskTodo>;

interface LoadableTaskTodoStoreSnapshot {
  version: 1;
  todos: TaskTodoStoreEntry[];
}

export interface TaskGraphStoreLockOptions {
  /** Maximum time to wait for another process to release the lock. Default: 10s. */
  timeoutMs?: number;
  /** Poll interval while waiting for the lock. Default: 25ms. */
  retryIntervalMs?: number;
  /** Treat a lock directory older than this as stale and remove it. Default: 60s. */
  staleMs?: number;
}

export interface TaskGraphStoreUpdateOptions extends TaskGraphStoreLockOptions {
  /** Create an empty graph when the store file does not exist. Default: true. */
  createIfMissing?: boolean;
}

export interface TaskGraphStoreUpdateResult<T> {
  graph: TaskGraph | null;
  result: T;
}

export class TaskGraphStoreConflictError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`Spark task graph changed since it was loaded: ${filePath}`);
    this.name = "TaskGraphStoreConflictError";
    this.filePath = filePath;
  }
}

export class TaskGraphStoreLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`timed out waiting for Spark task graph lock: ${lockPath}`);
    this.name = "TaskGraphStoreLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class TaskGraphStoreLockOwnerFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid Spark task graph lock owner: ${filePath}: ${message}`);
    this.name = "TaskGraphStoreLockOwnerFormatError";
    this.filePath = filePath;
  }
}

export class TaskGraphStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid Spark task graph store: ${filePath}: ${message}`);
    this.name = "TaskGraphStoreFormatError";
    this.filePath = filePath;
  }
}

export class TaskTodoStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid Spark task TODO store: ${filePath}: ${message}`);
    this.name = "TaskTodoStoreFormatError";
    this.filePath = filePath;
  }
}

const taskGraphSourceHashes = new WeakMap<TaskGraph, string>();
const taskGraphStoreLockDepth = new AsyncLocalStorage<number>();

export class TaskGraph {
  #projects = new Map<ProjectRef, Project>();
  #tasks = new Map<TaskRef, Task>();
  #dependencies: TaskDependency[] = [];
  #runs = new Map<string, TaskRun>();
  #todos = new Map<TaskRef, TaskTodo[]>();

  static fromSnapshot(snapshot: TaskGraphSnapshot): TaskGraph {
    const graph = new TaskGraph();
    for (const project of snapshot.projects)
      graph.#projects.set(project.ref, normalizeProject(project));
    for (const task of snapshot.tasks) graph.#tasks.set(task.ref, normalizeTask(task));
    graph.#dependencies = snapshot.dependencies ?? [];
    for (const run of snapshot.runs ?? []) graph.#runs.set(run.ref, normalizeTaskRun(run));
    return graph;
  }

  snapshot(): TaskGraphSnapshot {
    return {
      projects: this.projects(),
      tasks: this.tasks(),
      dependencies: this.dependencies(),
      runs: this.runs(),
    };
  }

  createProject(input: CreateProjectInput): Project {
    if (!input.title.trim()) throw new Error("project title is required");
    const now = nowIso();
    const project: Project = {
      ref: newRef("proj"),
      title: input.title,
      description: input.description,
      status: normalizeProjectStatus(input.status),
      outputLanguage: input.outputLanguage,
      createdAt: now,
      updatedAt: now,
    };
    this.#projects.set(project.ref, project);
    return project;
  }

  createTask(input: CreateTaskInput): Task {
    this.getProject(input.projectRef);
    if (!input.title.trim()) throw new Error("task title is required");
    const now = nowIso();
    const name = uniqueTaskName(
      input.name?.trim() || taskNameFromTitle(input.title),
      new Set(this.tasks(input.projectRef).map((task) => task.name)),
    );
    const supersededBy = normalizeTaskRefs(input.supersededBy);
    const requestedStatus = input.status ?? (input.kind === "interaction" ? "running" : "ready");
    const status =
      supersededBy.length > 0 && requestedStatus !== "done" ? "cancelled" : requestedStatus;
    const task: Task = {
      ref: newRef("task"),
      projectRef: input.projectRef,
      name,
      title: input.title,
      description: input.description,
      kind: input.kind ?? "generic",
      status,
      roleRef: normalizeRoleRef(input.roleRef),
      finishedBy: input.finishedBy,
      cancellation:
        status === "cancelled"
          ? (normalizeTaskCancellation(input.cancellation, now) ?? { at: now })
          : undefined,
      supersededBy,
      claim: isUnfinishedTaskStatus(status) ? input.claim : undefined,
      inputArtifacts: input.inputArtifacts ?? [],
      outputArtifacts: [],
      plan: normalizeTaskPlan(input.plan, input.description, input.title),
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.set(task.ref, task);
    this.#todos.set(task.ref, normalizeTodos(materializeTodos(task.ref, input.todos ?? [], now)));
    return task;
  }

  acceptProposal(proposal: TaskProposal): Task {
    const task = this.createTask({
      projectRef: proposal.projectRef,
      title: proposal.title,
      description: proposal.description,
      kind: proposal.kind,
      roleRef: proposal.proposedRoleRef,
    });
    for (const dep of proposal.dependsOn ?? []) this.addDependency(task.ref, dep);
    return task;
  }

  planTasks(projectRef: ProjectRef, inputs: TaskPlanInput[]): TaskPlanResult {
    this.getProject(projectRef);
    const created: Task[] = [];
    const updated: Task[] = [];
    const skipped: Task[] = [];
    const dependencies: TaskDependency[] = [];
    const refsByKey = taskLookup(this.tasks(projectRef));
    for (const input of inputs) {
      const title = input.title.trim();
      const description = input.description.trim();
      const name = input.name?.trim();
      if (!title) throw new Error("task title is required");
      if (!description) throw new Error(`task description is required: ${title}`);
      const existing = this.tasks(projectRef).find(
        (task) => (name && task.name === name) || task.title === title,
      );
      const task = existing
        ? this.updateTask(existing.ref, {
            name: name ?? existing.name,
            title,
            description,
            kind: input.kind ?? existing.kind,
            status: input.status ?? existing.status,
            roleRef: normalizeRoleRef(input.roleRef ?? existing.roleRef),
            supersededBy: input.supersededBy ?? existing.supersededBy,
            plan: normalizeTaskPlan(input.plan, description, title),
          })
        : this.createTask({
            projectRef,
            name,
            title,
            description,
            kind: input.kind,
            status: input.status,
            roleRef: normalizeRoleRef(input.roleRef),
            supersededBy: input.supersededBy,
            plan: normalizeTaskPlan(input.plan, description, title),
          });
      if (existing) updated.push(task);
      else created.push(task);
      addTaskLookup(refsByKey, task);
    }

    for (const input of inputs) {
      const taskRef = refsByKey.get(input.name?.trim() || input.title.trim());
      if (!taskRef) continue;
      for (const dep of input.dependsOn ?? []) {
        const depRef = refsByKey.get(dep) ?? dep;
        if (!this.#tasks.has(depRef as TaskRef))
          throw new NotFoundError(`unknown dependency: ${dep}`);
        const already = this.#dependencies.some(
          (existing) => existing.taskRef === taskRef && existing.dependsOn === depRef,
        );
        if (already) {
          skipped.push(this.getTask(taskRef));
          continue;
        }
        dependencies.push(this.addDependency(taskRef, depRef as TaskRef));
      }
    }

    return { created, updated, skipped, dependencies };
  }

  bindRole(taskRef: TaskRef, roleRef: RoleRef): Task {
    const task = this.getTask(taskRef);
    this.assertDependenciesDone(task);
    const updated: Task = {
      ...task,
      roleRef,
      updatedAt: nowIso(),
    };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  setTaskStatus(
    taskRef: TaskRef,
    status: Task["status"],
    options: { cancelledBy?: string; cancellationReason?: string } = {},
  ): Task {
    const task = this.getTask(taskRef);
    if (status === "cancelled") this.assertTaskCanBeCancelled(task);
    const now = nowIso();
    const cancellation =
      status === "cancelled"
        ? normalizeTaskCancellation(
            {
              at: task.cancellation?.at ?? now,
              by: options.cancelledBy ?? task.cancellation?.by,
              reason: options.cancellationReason ?? task.cancellation?.reason,
            },
            now,
          )
        : undefined;
    const updated = {
      ...task,
      status,
      finishedBy: isUnfinishedTaskStatus(status)
        ? task.finishedBy
        : (task.finishedBy ?? attributionFromTask(task)),
      cancellation,
      claim: isUnfinishedTaskStatus(status) ? task.claim : undefined,
      updatedAt: now,
    };
    this.#tasks.set(taskRef, updated);
    if (
      this.getProject(task.projectRef).currentTaskRef === taskRef &&
      !isOpenContextTask(updated)
    ) {
      const replacement = this.findOpenContextTask(task.projectRef, taskRef);
      this.setCurrentTask(task.projectRef, replacement?.ref);
    }
    return updated;
  }

  claimTask(taskRef: TaskRef, input: ClaimTaskInput): Task {
    const task = this.getTask(taskRef);
    const now = input.now ?? nowIso();
    if (!isUnfinishedTaskStatus(task.status))
      throw new DependencyError(`finished task cannot be claimed: ${task.ref}`);
    const claimedBy = input.claimedBy.trim();
    if (!claimedBy) throw new Error("task claim claimedBy is required");
    this.assertDependenciesDone(task);
    const roleRef = normalizeRoleRef(input.roleRef ?? task.roleRef);
    const runName = input.runName?.trim() || task.claim?.runName;
    const sessionId = input.sessionId?.trim() || undefined;
    const requestedClaimScope = claimScopeForInput({
      kind: input.kind,
      sessionId,
      runName,
    });
    if (input.kind === "role-run") this.assertTaskPlanReady(task);
    const activeClaimScope = task.claim
      ? isExpiredClaim(task.claim, now)
        ? undefined
        : claimScopeForStoredClaim(task.claim)
      : undefined;
    if (activeClaimScope && activeClaimScope.key !== requestedClaimScope.key)
      throw new DependencyError(`task is already claimed: ${task.ref}`);
    const conflictingClaim = [...this.#tasks.values()].find((candidate) => {
      if (candidate.ref === task.ref) return false;
      if (!isUnfinishedTaskStatus(candidate.status)) return false;
      if (!candidate.claim || isExpiredClaim(candidate.claim, now)) return false;
      return claimScopeForStoredClaim(candidate.claim).key === requestedClaimScope.key;
    });
    if (conflictingClaim)
      throw new DependencyError(
        `${requestedClaimScope.label} already has an unfinished claimed task: ${conflictingClaim.ref}`,
      );
    const claim: TaskClaim = {
      kind: input.kind,
      claimedBy,
      roleRef,
      runName,
      sessionId,
      runRef: input.runRef,
      claimedAt:
        activeClaimScope?.key === requestedClaimScope.key ? (task.claim?.claimedAt ?? now) : now,
      heartbeatAt: now,
      expiresAt: claimExpiresAt(now, input.leaseMs),
    };
    const updated: Task = {
      ...task,
      roleRef: task.roleRef,
      status: isUnfinishedTaskStatus(task.status) ? "running" : task.status,
      claim,
      updatedAt: now,
    };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  heartbeatTaskClaim(taskRef: TaskRef, input: HeartbeatTaskClaimInput): Task {
    const task = this.getTask(taskRef);
    const now = input.now ?? nowIso();
    if (!task.claim) throw new DependencyError(`task is not claimed: ${task.ref}`);
    if (task.claim.claimedBy !== input.claimedBy)
      throw new DependencyError(`task is claimed by ${task.claim.claimedBy}`);
    if (isExpiredClaim(task.claim, now))
      throw new DependencyError(`task claim is expired: ${task.ref}`);
    const claim: TaskClaim = {
      ...task.claim,
      heartbeatAt: now,
      expiresAt: claimExpiresAt(now, input.leaseMs),
    };
    const updated: Task = { ...task, claim, updatedAt: now };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  releaseTaskClaim(taskRef: TaskRef, claimedBy?: string): Task {
    const task = this.getTask(taskRef);
    if (claimedBy && task.claim && task.claim.claimedBy !== claimedBy)
      throw new DependencyError(`task is claimed by ${task.claim.claimedBy}`);
    const updated: Task = {
      ...task,
      claim: undefined,
      status: task.status === "running" ? "pending" : task.status,
      updatedAt: nowIso(),
    };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  expireTaskClaims(now = nowIso()): Task[] {
    const expired: Task[] = [];
    for (const task of this.#tasks.values()) {
      if (!task.claim || !isExpiredClaim(task.claim, now)) continue;
      if (task.claim.runRef) {
        const run = this.#runs.get(task.claim.runRef);
        if (run?.status === "running" || run?.status === "queued") {
          this.#runs.set(task.claim.runRef, {
            ...run,
            status: "cancelled",
            failureKind: "claim_stale",
            errorMessage: `task claim expired at ${task.claim.expiresAt}`,
            finishedAt: now,
          });
        }
      }
      const updated: Task = {
        ...task,
        claim: undefined,
        status: task.status === "running" ? "pending" : task.status,
        updatedAt: now,
      };
      this.#tasks.set(task.ref, updated);
      expired.push(updated);
    }
    return expired;
  }

  recordRun(run: TaskRun): TaskRun {
    this.#runs.set(run.ref, run);
    return run;
  }

  mergeTaskProgressFrom(source: TaskGraph, taskRefs: Iterable<TaskRef>): void {
    const refs = new Set(taskRefs);
    for (const ref of refs) {
      const task = source.#tasks.get(ref);
      if (task) this.#tasks.set(ref, cloneTask(task));
    }
    for (const run of source.#runs.values()) {
      if (refs.has(run.taskRef)) this.#runs.set(run.ref, cloneTaskRun(run));
    }
  }

  updateTask(
    taskRef: TaskRef,
    patch: Partial<
      Pick<
        Task,
        | "name"
        | "title"
        | "description"
        | "kind"
        | "status"
        | "roleRef"
        | "finishedBy"
        | "cancellation"
        | "supersededBy"
        | "claim"
        | "plan"
      >
    >,
  ): Task {
    const task = this.getTask(taskRef);
    const now = nowIso();
    const supersededBy =
      patch.supersededBy === undefined ? task.supersededBy : normalizeTaskRefs(patch.supersededBy);
    const statusCandidate = patch.status ?? task.status;
    const status =
      patch.supersededBy !== undefined && supersededBy.length > 0 && statusCandidate !== "done"
        ? "cancelled"
        : statusCandidate;
    if (status === "cancelled") this.assertTaskCanBeCancelled(task);
    const name = patch.name === undefined ? task.name : patch.name.trim();
    const cancellation =
      status === "cancelled"
        ? (normalizeTaskCancellation(patch.cancellation ?? task.cancellation, now) ?? { at: now })
        : undefined;
    const updated: Task = {
      ...task,
      name,
      title: patch.title ?? task.title,
      description: patch.description ?? task.description,
      kind: patch.kind ?? task.kind,
      status,
      roleRef: normalizeRoleRef(patch.roleRef ?? task.roleRef),
      finishedBy: isUnfinishedTaskStatus(status)
        ? (patch.finishedBy ?? task.finishedBy)
        : (patch.finishedBy ?? task.finishedBy ?? attributionFromTask({ ...task, ...patch })),
      cancellation,
      supersededBy,
      claim: isUnfinishedTaskStatus(status) ? (patch.claim ?? task.claim) : undefined,
      plan: normalizeTaskPlan(
        patch.plan ?? task.plan,
        patch.description ?? task.description,
        patch.title ?? task.title,
      ),
      updatedAt: now,
    };
    assertTaskName(updated.name);
    assertUniqueTaskName(this.tasks(task.projectRef), updated.name, taskRef);
    if (!updated.title.trim()) throw new Error("task title is required");
    if (!updated.description.trim()) throw new Error("task description is required");
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  attachOutputArtifact(taskRef: TaskRef, artifactRef: ArtifactRef): Task {
    const task = this.getTask(taskRef);
    const outputArtifacts = task.outputArtifacts.includes(artifactRef)
      ? task.outputArtifacts
      : [...task.outputArtifacts, artifactRef];
    const updated = { ...task, outputArtifacts, updatedAt: nowIso() };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  setCurrentTask(projectRef: ProjectRef, taskRef?: TaskRef): Project {
    const project = this.getProject(projectRef);
    if (taskRef) {
      const task = this.getTask(taskRef);
      if (task.projectRef !== projectRef)
        throw new DependencyError("current task must belong to project");
    }
    const updated: Project = {
      ...project,
      currentTaskRef: taskRef,
      updatedAt: nowIso(),
    };
    this.#projects.set(projectRef, updated);
    return updated;
  }

  currentTask(projectRef: ProjectRef): Task | undefined {
    const project = this.getProject(projectRef);
    if (!project.currentTaskRef) return undefined;
    const current = this.#tasks.get(project.currentTaskRef);
    if (current && current.projectRef === projectRef) return current;
    return undefined;
  }

  setTaskTodos(taskRef: TaskRef, todos: CreateTaskTodoInput[]): Task {
    const task = this.getTask(taskRef);
    this.#todos.set(taskRef, normalizeTodos(materializeTodos(taskRef, todos, nowIso())));
    const updated: Task = { ...task, updatedAt: nowIso() };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  applyTodoOps(taskRef: TaskRef, ops: TaskTodoOp[]): Task {
    if (ops.length === 0) throw new Error("todo ops are required");
    const task = this.getTask(taskRef);
    this.#todos.set(taskRef, applyTaskTodoOps(taskRef, this.taskTodos(taskRef), ops));
    const updated: Task = { ...task, updatedAt: nowIso() };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  taskTodos(taskRef: TaskRef): TaskTodo[] {
    this.getTask(taskRef);
    return cloneTodos(this.#todos.get(taskRef) ?? []);
  }

  hydrateTodos(todos: TaskTodo[]): void {
    this.#todos.clear();
    for (const todo of todos) {
      if (!this.#tasks.has(todo.taskRef)) continue;
      const list = this.#todos.get(todo.taskRef) ?? [];
      list.push(normalizeTodo(todo));
      this.#todos.set(todo.taskRef, list);
    }
    for (const [taskRef, todosForTask] of this.#todos) {
      this.#todos.set(taskRef, normalizeTodos(todosForTask));
    }
  }

  todoSnapshot(): TaskTodo[] {
    return this.tasks().flatMap((task) => this.taskTodos(task.ref));
  }

  todoSummary(taskRef: TaskRef): TaskTodoSummary {
    return summarizeTodos(this.taskTodos(taskRef));
  }

  projectTodoSummary(projectRef: ProjectRef): ProjectTodoSummary {
    const tasks = this.tasks(projectRef);
    const allTodos = tasks.flatMap((task) => this.taskTodos(task.ref));
    return {
      ...summarizeTodos(allTodos),
      tasksWithTodos: tasks.filter((task) => this.taskTodos(task.ref).length > 0).length,
    };
  }

  addDependency(taskRef: TaskRef, dependsOn: TaskRef): TaskDependency {
    const task = this.getTask(taskRef);
    const prerequisite = this.getTask(dependsOn);
    if (task.projectRef !== prerequisite.projectRef)
      throw new DependencyError("task dependencies cannot cross projects");
    if (taskRef === dependsOn) throw new DependencyError("task cannot depend on itself");
    if (prerequisite.status === "cancelled" && task.status !== "cancelled")
      throw new DependencyError(
        `task cannot depend on cancelled task: ${taskRef} depends on ${dependsOn}`,
      );
    const dependency = { taskRef, dependsOn };
    if (this.#dependencies.some((dep) => dep.taskRef === taskRef && dep.dependsOn === dependsOn))
      return dependency;
    const next = [...this.#dependencies, dependency];
    assertAcyclic(next);
    this.#dependencies = next;
    if (task.status === "ready" && prerequisite.status !== "done") {
      this.#tasks.set(taskRef, { ...task, status: "pending", updatedAt: nowIso() });
    }
    return dependency;
  }

  readyTasks(projectRef?: ProjectRef): Task[] {
    const tasks = this.tasks(projectRef);
    const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.ref));
    return tasks.filter((task) => {
      if (task.status !== "pending" && task.status !== "ready") return false;
      if (!taskPlanReadiness(task).ready) return false;
      return this.#dependencies
        .filter((dep) => dep.taskRef === task.ref)
        .every((dep) => done.has(dep.dependsOn));
    });
  }

  taskPlanReadiness(taskRef: TaskRef): TaskPlanReadiness {
    return taskPlanReadiness(this.getTask(taskRef));
  }

  enqueueReadyTasks(projectRef?: ProjectRef): Task[] {
    return this.readyTasks(projectRef).map((task) => this.setTaskStatus(task.ref, "ready"));
  }

  unmetDependencies(taskRef: TaskRef): Task[] {
    const task = this.getTask(taskRef);
    return this.#dependencies
      .filter((dep) => dep.taskRef === task.ref)
      .map((dep) => this.getTask(dep.dependsOn))
      .filter((dependency) => dependency.status !== "done");
  }

  dependentTasks(taskRef: TaskRef): Task[] {
    const task = this.getTask(taskRef);
    return this.#dependencies
      .filter((dep) => dep.dependsOn === task.ref)
      .map((dep) => this.getTask(dep.taskRef));
  }

  private assertTaskCanBeCancelled(task: Task): void {
    const dependents = this.dependentTasks(task.ref).filter(
      (dependent) => dependent.status !== "cancelled",
    );
    if (dependents.length === 0) return;
    throw new DependencyError(
      `task has dependent tasks and cannot be cancelled: ${task.ref} is depended on by ${dependents
        .map((dependent) => dependent.ref)
        .join(", ")}`,
    );
  }

  private assertDependenciesDone(task: Task): void {
    const unmet = this.unmetDependencies(task.ref);
    if (unmet.length === 0) return;
    throw new DependencyError(
      `task has unmet dependencies: ${task.ref} depends on ${unmet
        .map((dependency) => dependency.ref)
        .join(", ")}`,
    );
  }

  private assertTaskPlanReady(task: Task): void {
    const readiness = taskPlanReadiness(task);
    if (readiness.ready) return;
    throw new DependencyError(
      `task plan is not execution-ready: ${task.ref}: ${readiness.issues
        .map((issue) => `${issue.message} fix: ${issue.remediation}`)
        .join("; ")}`,
    );
  }

  getProject(ref: ProjectRef): Project {
    const project = this.#projects.get(ref);
    if (!project) throw new NotFoundError(`unknown project: ${ref}`);
    return project;
  }

  updateProject(
    projectRef: ProjectRef,
    patch: Partial<Pick<Project, "title" | "description" | "status" | "outputLanguage">>,
  ): Project {
    const project = this.getProject(projectRef);
    const title = patch.title ?? project.title;
    const description = patch.description ?? project.description;
    if (!title.trim()) throw new Error("project title is required");
    if (!description.trim()) throw new Error("project description is required");
    const updated: Project = {
      ...project,
      title,
      description,
      status: normalizeProjectStatus(patch.status ?? project.status),
      outputLanguage: patch.outputLanguage ?? project.outputLanguage,
      updatedAt: nowIso(),
    };
    this.#projects.set(projectRef, updated);
    return updated;
  }

  getTask(ref: TaskRef): Task {
    const task = this.#tasks.get(ref);
    if (!task) throw new NotFoundError(`unknown task: ${ref}`);
    return task;
  }

  projects(): Project[] {
    return [...this.#projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  tasks(projectRef?: ProjectRef): Task[] {
    return [...this.#tasks.values()]
      .filter((task) => !projectRef || task.projectRef === projectRef)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  dependencies(projectRef?: ProjectRef): TaskDependency[] {
    if (!projectRef) return [...this.#dependencies];
    const refs = new Set(this.tasks(projectRef).map((task) => task.ref));
    return this.#dependencies.filter((dep) => refs.has(dep.taskRef));
  }

  runs(projectRef?: ProjectRef): TaskRun[] {
    return [...this.#runs.values()]
      .filter((run) => !projectRef || run.projectRef === projectRef)
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  }

  findOpenContextTask(projectRef: ProjectRef, excludeTaskRef?: TaskRef): Task | undefined {
    return this.tasks(projectRef).find(
      (task) =>
        task.ref !== excludeTaskRef && task.kind === "interaction" && isOpenContextTask(task),
    );
  }
}

export class TaskGraphStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async save(graph: TaskGraph): Promise<void> {
    if (taskGraphStoreLockDepth.getStore()) {
      await this.saveUnlocked(graph);
      return;
    }
    await this.withLock(async () => {
      await this.assertGraphNotStale(graph);
      await this.saveUnlocked(graph);
    });
  }

  private async saveUnlocked(graph: TaskGraph): Promise<void> {
    const snapshot = graph.snapshot();
    const data = formatJsonFile(snapshot);
    await writeJsonFileAtomic(this.filePath, snapshot);
    taskGraphSourceHashes.set(graph, stableId(data));
  }

  async load(): Promise<TaskGraph | null> {
    let data: string;
    try {
      data = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) return null;
      throw error;
    }
    const snapshot = parseTaskGraphStoreJson(data, this.filePath);
    let graph: TaskGraph;
    try {
      graph = TaskGraph.fromSnapshot(snapshot as TaskGraphSnapshot);
    } catch (error) {
      throw new TaskGraphStoreFormatError(
        this.filePath,
        `not valid task graph snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    taskGraphSourceHashes.set(graph, stableId(data));
    return graph;
  }

  async withLock<T>(fn: () => T | Promise<T>, options: TaskGraphStoreLockOptions = {}): Promise<T> {
    if (taskGraphStoreLockDepth.getStore()) return fn();
    const release = await acquireTaskGraphStoreLock(this.lockPath, options);
    return taskGraphStoreLockDepth.run(1, async () => {
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  async update<T>(
    fn: (graph: TaskGraph) => T | Promise<T>,
    options: TaskGraphStoreUpdateOptions = {},
  ): Promise<TaskGraphStoreUpdateResult<T>> {
    const createIfMissing = options.createIfMissing ?? true;
    return this.withLock(async () => {
      const graph = await this.load();
      if (!graph) {
        if (!createIfMissing) return { graph: null, result: undefined as T };
        const created = new TaskGraph();
        const result = await fn(created);
        await this.saveUnlocked(created);
        return { graph: created, result };
      }
      const result = await fn(graph);
      await this.saveUnlocked(graph);
      return { graph, result };
    }, options);
  }

  private async assertGraphNotStale(graph: TaskGraph): Promise<void> {
    const sourceHash = taskGraphSourceHashes.get(graph);
    if (!sourceHash) return;
    try {
      const current = await readFile(this.filePath, "utf8");
      if (stableId(current) !== sourceHash) throw new TaskGraphStoreConflictError(this.filePath);
    } catch (error) {
      if (isFileNotFoundError(error)) throw new TaskGraphStoreConflictError(this.filePath);
      throw error;
    }
  }
}

export function defaultTaskGraphStore(cwd: string): TaskGraphStore {
  return new TaskGraphStore(join(cwd, ".spark", "projects.json"));
}

function parseTaskGraphStoreJson(text: string, filePath: string): unknown {
  const raw = parseJsonFileText(
    text,
    filePath,
    (path, message) => new TaskGraphStoreFormatError(path, message),
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreFormatError(filePath, "JSON root must be an object");
  }
  return raw;
}

async function acquireTaskGraphStoreLock(
  lockPath: string,
  options: TaskGraphStoreLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? 25);
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  const ownerId = stableId(`${process.pid}:${started}:${Math.random()}`);
  const ownerPath = join(lockPath, "owner.json");
  const ownerJson = () =>
    `${JSON.stringify(
      {
        ownerId,
        pid: process.pid,
        startedAt: new Date(started).toISOString(),
        heartbeatAt: nowIso(),
      },
      null,
      2,
    )}\n`;

  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      await writeLockOwnerFile(ownerPath, ownerJson());
      const refreshMs =
        staleMs > 0 ? Math.max(1_000, Math.min(30_000, Math.floor(staleMs / 3))) : undefined;
      let heartbeatError: unknown;
      let heartbeatWrite: Promise<void> | undefined;
      const refreshTimer = refreshMs
        ? setInterval(() => {
            heartbeatWrite = writeLockOwnerFile(ownerPath, ownerJson()).catch((error) => {
              heartbeatError = error;
            });
          }, refreshMs)
        : undefined;
      refreshTimer?.unref?.();
      return async () => {
        if (refreshTimer) clearInterval(refreshTimer);
        await heartbeatWrite;
        if (await lockOwnerMatches(ownerPath, ownerId))
          await rm(lockPath, { recursive: true, force: true });
        if (heartbeatError) {
          throw new Error(
            `Spark task graph lock heartbeat failed: ${unknownErrorMessage(heartbeatError)}`,
          );
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleTaskGraphStoreLock(lockPath, staleMs);
      if (Date.now() - started >= timeoutMs) throw new TaskGraphStoreLockTimeoutError(lockPath);
      await sleep(retryIntervalMs);
    }
  }
}

async function writeLockOwnerFile(ownerPath: string, data: string): Promise<void> {
  const tempPath = `${ownerPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, ownerPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function removeStaleTaskGraphStoreLock(lockPath: string, staleMs: number): Promise<void> {
  if (staleMs < 0) return;
  try {
    const heartbeatMs = await taskGraphStoreLockHeartbeatMs(lockPath);
    if (Date.now() - heartbeatMs >= staleMs) await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function taskGraphStoreLockHeartbeatMs(lockPath: string): Promise<number> {
  const ownerPath = join(lockPath, "owner.json");
  try {
    const ownerRaw = await readFile(ownerPath, "utf8");
    return parseTaskGraphStoreLockOwner(ownerPath, ownerRaw).heartbeatMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return (await stat(lockPath)).mtimeMs;
  }
}

async function lockOwnerMatches(ownerPath: string, ownerId: string): Promise<boolean> {
  try {
    const owner = parseTaskGraphStoreLockOwner(ownerPath, await readFile(ownerPath, "utf8"));
    return owner.ownerId === ownerId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseTaskGraphStoreLockOwner(
  filePath: string,
  text: string,
): { ownerId: string; heartbeatMs: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TaskGraphStoreLockOwnerFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "JSON root must be an object");
  }
  const owner = raw as Record<string, unknown>;
  if (typeof owner.ownerId !== "string" || !owner.ownerId.trim()) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "ownerId must be a non-empty string");
  }
  if (typeof owner.heartbeatAt !== "string" || !owner.heartbeatAt.trim()) {
    throw new TaskGraphStoreLockOwnerFormatError(
      filePath,
      "heartbeatAt must be a non-empty string",
    );
  }
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "heartbeatAt must be a valid date");
  }
  return { ownerId: owner.ownerId, heartbeatMs };
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class TaskTodoStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(todos: TaskTodo[] | TaskGraph): Promise<void> {
    const snapshot: TaskTodoStoreSnapshot = {
      version: 1,
      todos: Array.isArray(todos) ? cloneTodos(todos) : todos.todoSnapshot(),
    };
    await writeJsonFileAtomic(this.filePath, snapshot);
  }

  async load(): Promise<TaskTodo[] | null> {
    const raw = await readJsonFileOptional(
      this.filePath,
      (path, message) => new TaskTodoStoreFormatError(path, message),
    );
    if (raw === undefined) return null;
    assertTaskTodoStoreSnapshot(raw, this.filePath);
    return (raw.todos ?? []).map(normalizeTodo);
  }

  async hydrate(graph: TaskGraph): Promise<boolean> {
    const todos = await this.load();
    if (!todos) return false;
    graph.hydrateTodos(todos);
    return true;
  }
}

export function defaultTaskTodoStore(cwd: string, scope: string): TaskTodoStore {
  return new TaskTodoStore(join(cwd, ".spark", "todos", `${sanitizeTodoStoreScope(scope)}.json`));
}

function sanitizeTodoStoreScope(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe || "default";
}

function assertTaskTodoStoreSnapshot(
  value: unknown,
  filePath: string,
): asserts value is LoadableTaskTodoStoreSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskTodoStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as { todos?: unknown; version?: unknown };
  if (snapshot.version !== 1) {
    throw new TaskTodoStoreFormatError(filePath, "version must be 1");
  }
  if (!Array.isArray(snapshot.todos)) {
    throw new TaskTodoStoreFormatError(filePath, "todos must be an array");
  }
  snapshot.todos.forEach((todo, index) => {
    assertTaskTodoStoreEntry(todo, filePath, index);
  });
}

function assertTaskTodoStoreEntry(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is TaskTodoStoreEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}] must be an object`);
  }
  const todo = value as Partial<Record<keyof TaskTodo, unknown>>;
  if (typeof todo.taskRef !== "string" || !todo.taskRef) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].taskRef must be a string`);
  }
  if (typeof todo.content !== "string" || !todo.content.trim()) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].content must be a string`);
  }
  if (!isTaskTodoStatus(todo.status)) {
    throw new TaskTodoStoreFormatError(
      filePath,
      `todos[${index}].status must be a valid TODO status`,
    );
  }
  if (todo.notes !== undefined && !isStringArray(todo.notes)) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].notes must be a string array`);
  }
  if (todo.blockedBy !== undefined && !isStringArray(todo.blockedBy)) {
    throw new TaskTodoStoreFormatError(
      filePath,
      `todos[${index}].blockedBy must be a string array`,
    );
  }
  if (todo.deletedAt !== undefined && typeof todo.deletedAt !== "string") {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].deletedAt must be a string`);
  }
}

function isTaskTodoStatus(value: unknown): value is TaskTodoStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "deleted"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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

function isExpiredClaim(claim: TaskClaim, now: string): boolean {
  const expiresAt = claim.expiresAt?.trim();
  if (!expiresAt) return true;
  return Date.parse(expiresAt) <= Date.parse(now);
}

function claimExpiresAt(now: string, leaseMs: number): string {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error("task claim leaseMs must be positive");
  return new Date(Date.parse(now) + leaseMs).toISOString();
}

interface ClaimScope {
  key: string;
  label: string;
}

function claimScopeForInput(input: {
  kind: TaskClaimKind;
  sessionId?: string;
  runName?: string;
}): ClaimScope {
  return claimScopeForValues(input.kind, input.sessionId, input.runName);
}

function claimScopeForStoredClaim(claim: TaskClaim): ClaimScope {
  return claimScopeForValues(claim.kind, claim.sessionId, claim.runName);
}

function claimScopeForValues(
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

function normalizeRoleRef(value: RoleRef | undefined): RoleRef | undefined {
  if (!value) return undefined;
  return assertRef(value, "role");
}

function rejectLegacyRoleFields(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.agentRef !== undefined) throw new Error(`${label} uses legacy agentRef; use roleRef`);
  if (record.agentName !== undefined)
    throw new Error(`${label} uses legacy agentName; use runName`);
}

function rejectLegacyClaimFields(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.claimedBySession !== undefined)
    throw new Error(`${label} uses legacy claimedBySession; use claim.sessionId`);
}

function taskNameFromTitle(title: string): string {
  const ascii = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return ascii || `task-${stableId(title)}`;
}

function assertTaskName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
    throw new Error(`task name must be a simple @name handle: ${name}`);
}

function uniqueTaskName(preferred: string, existing: Set<string>): string {
  const base = preferred.trim();
  assertTaskName(base);
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function assertUniqueTaskName(tasks: Task[], name: string, exceptTaskRef?: TaskRef): void {
  const conflict = tasks.find((task) => task.ref !== exceptTaskRef && task.name === name);
  if (conflict) throw new Error(`task name already exists in project: ${name}`);
}

function addTaskLookup(lookup: Map<string, TaskRef>, task: Task): void {
  lookup.set(task.name, task.ref);
  lookup.set(task.title, task.ref);
  lookup.set(task.ref, task.ref);
}

function taskLookup(tasks: Task[]): Map<string, TaskRef> {
  const lookup = new Map<string, TaskRef>();
  for (const task of tasks) addTaskLookup(lookup, task);
  return lookup;
}

function normalizeProject(project: Project): Project {
  return {
    ...project,
    status: normalizeProjectStatus(project.status),
    currentTaskRef: project.currentTaskRef,
  };
}

function normalizeProjectStatus(status: unknown): ProjectStatus {
  return status === "done" ? "done" : "active";
}

function normalizeTask(task: Task): Task {
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
  return {
    objective,
    contextRefs: normalizeStringList(plan?.contextRefs),
    constraints: normalizeStringList(plan?.constraints),
    nonGoals: normalizeStringList(plan?.nonGoals),
    successCriteria: normalizeStringList(plan?.successCriteria),
    evidenceRequired: normalizeStringList(plan?.evidenceRequired),
    steps: normalizeStringList(plan?.steps).length
      ? normalizeStringList(plan?.steps)
      : [description.trim() || title.trim()],
    decompositionRationale: plan?.decompositionRationale?.trim() || undefined,
    riskLevel: normalizeTaskPlanRiskLevel(plan?.riskLevel),
    openQuestions: normalizeStringList(plan?.openQuestions),
    askRefs: normalizeStringList(plan?.askRefs) as TaskPlan["askRefs"],
  };
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
    "task_not_concrete: Spark tasks must be concrete executable/review/validation work, not standalone design/planning placeholders.",
    ...issues.map((issue) => `- @${issue.name ?? "unnamed"}: ${issue.title} - ${issue.message}`),
    "Discuss design/architecture decisions with the user first, then embed the chosen design in each concrete task.plan.",
  ].join("\n");
}

function nonConcreteTaskMessage(task: TaskPlanInput): string | undefined {
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
      "Add a concrete plan with objective, success criteria, evidence requirements, and steps.",
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
    message: "Task plan needs execution steps.",
    remediation: "Add at least one concrete execution step to plan.steps.",
    description: "plan.steps must include at least one execution step.",
  },
  {
    kind: "open_questions",
    severity: "blocking",
    message: "Task plan has unresolved questions.",
    remediation:
      "Resolve material questions with spark_ask, then move decisions into askRefs or the plan body.",
    description:
      "plan.openQuestions must be empty; resolve material questions through context-specific spark_ask artifacts before planning.",
  },
];

const TASK_PLAN_READINESS_RULE_BY_KIND = new Map(
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
  if (plan.steps.length === 0) {
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

function summarizeTaskPlanIssues(task: Task, issues: TaskPlanIssue[]): string {
  const issueSummary = issues
    .map((issue) => `${issue.message} fix: ${issue.remediation}`)
    .join(" ");
  return `Task @${task.name} "${task.title}" needs a concrete, context-specific plan before creation or update. ${issueSummary}`;
}

function taskPlanIssue(kind: TaskPlanIssueKind, message?: string): TaskPlanIssue {
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
  const evidenceRequired = task.plan?.evidenceRequired ?? [];
  if (evidenceRequired.length === 0) return { ready: true, issues: [] };
  if (task.outputArtifacts.length > 0) return { ready: true, issues: [] };
  const issues: TaskCompletionIssue[] = [
    {
      kind: "missing_completion_evidence",
      severity: "blocking",
      evidenceRequired,
      message: `Task completion needs evidence artifacts: ${evidenceRequired.join("; ")}`,
    },
  ];
  return { ready: false, issues };
}

function cloneTaskPlan(plan: TaskPlan): TaskPlan {
  return {
    ...plan,
    contextRefs: [...plan.contextRefs],
    constraints: [...plan.constraints],
    nonGoals: [...plan.nonGoals],
    successCriteria: [...plan.successCriteria],
    evidenceRequired: [...plan.evidenceRequired],
    steps: [...plan.steps],
    openQuestions: [...plan.openQuestions],
    askRefs: [...plan.askRefs],
  };
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeTaskRefs(values: readonly string[] | undefined): TaskRef[] {
  return normalizeStringList(values).map((value) => assertRef(value, "task"));
}

function normalizeTaskCancellation(
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

function normalizeTaskPlanRiskLevel(value: unknown): TaskPlan["riskLevel"] {
  return value === "trivial" || value === "high" ? value : "normal";
}

function attributionFromTask(task: Pick<Task, "claim">): TaskAttribution | undefined {
  const sessionId = task.claim?.sessionId;
  const roleRef = task.claim?.kind === "role-run" ? task.claim.roleRef : undefined;
  const runName = task.claim?.kind === "role-run" ? task.claim.runName?.trim() : undefined;
  return normalizeTaskAttribution({ sessionId, roleRef, runName });
}

function normalizeTaskAttribution(
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

function normalizeTaskClaim(claim: TaskClaim | undefined): TaskClaim | undefined {
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

interface TodoReducerItem {
  id?: string;
  content: string;
  status: TaskTodoStatus;
  notes?: string[];
  blockedBy?: string[];
  updatedAt?: string;
  deletedAt?: string;
}

interface TodoReducerOptions<T extends TodoReducerItem> {
  createItem: (content: string, index: number, now: string) => T;
  createNotFoundError: (id: string | undefined, content: string | undefined) => Error;
  isLiveForProgress: (todo: T) => boolean;
}

function applyTaskTodoOps(taskRef: TaskRef, todos: TaskTodo[], ops: TaskTodoOp[]): TaskTodo[] {
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

function applyTodoListOps<T extends TodoReducerItem>(
  todos: T[],
  ops: TaskTodoOp[],
  options: TodoReducerOptions<T>,
): T[] {
  let next = cloneTodoList(todos);
  for (const op of ops) next = applyTodoListOp(next, op, options);
  return normalizeTodoList(next, options.isLiveForProgress);
}

function applyTodoListOp<T extends TodoReducerItem>(
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

function materializeTodoListItems<T extends TodoReducerItem>(
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

function patchTodoListStatus<T extends TodoReducerItem>(
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

function resolveTodoListItem<T extends TodoReducerItem>(
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

function normalizeTodoList<T extends TodoReducerItem>(
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

function cloneTodoList<T extends TodoReducerItem>(todos: T[]): T[] {
  return todos.map((todo) => ({
    ...todo,
    notes: todo.notes ? [...todo.notes] : undefined,
    blockedBy: todo.blockedBy ? [...todo.blockedBy] : undefined,
  }));
}

function sameTodoItem(left: TodoReducerItem, right: TodoReducerItem): boolean {
  if (left.id || right.id) return left.id === right.id;
  return left.content === right.content;
}

function materializeIndependentTodo(content: string, index: number, now: string): SessionTodoEntry {
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

function materializeTodos(
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

function cloneTask(task: Task): Task {
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

function normalizeTaskRun(run: TaskRun): TaskRun {
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

function cloneTaskRun(run: TaskRun): TaskRun {
  return normalizeTaskRun(run);
}

function cloneTodos(todos: TaskTodo[]): TaskTodo[] {
  return todos.map((todo) => ({
    ...todo,
    notes: todo.notes ? [...todo.notes] : undefined,
    blockedBy: todo.blockedBy ? [...todo.blockedBy] : undefined,
  }));
}

export function isUnfinishedTaskStatus(status: Task["status"]): boolean {
  return status !== "done" && status !== "failed" && status !== "cancelled";
}

function normalizeTodo(todo: TaskTodoStoreEntry): TaskTodo {
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

function normalizeTodos(todos: TaskTodo[]): TaskTodo[] {
  return normalizeTodoList(todos, (todo) => todo.status !== "deleted");
}

function summarizeTodos(todos: TaskTodo[]): TaskTodoSummary {
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

function todoIdFromContent(content: string, index: number): string {
  return `todo-${stableHash(`${index}:${content}`).slice(0, 12)}`;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isOpenContextTask(task: Task): boolean {
  return !["done", "failed", "cancelled"].includes(task.status);
}
