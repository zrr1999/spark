import {
  DependencyError,
  NotFoundError,
  newRef,
  nowIso,
  type ArtifactRef,
  type Project,
  type ProjectRef,
  type ProjectRoadmap,
  type RoadmapItem,
  type RoadmapItemRef,
  type RoleRef,
  type Task,
  type TaskClaim,
  type TaskDependency,
  type TaskPlanReadiness,
  type TaskProposal,
  type TaskRef,
  type TaskRun,
  type TaskTodo,
} from "pi-extension-api";
import { createDefaultProjectRoadmap, normalizeProjectRoadmap, uniqueTaskRefs } from "./roadmap.ts";
import type {
  ClaimTaskInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTaskTodoInput,
  HeartbeatTaskClaimInput,
  ProjectTodoSummary,
  TaskGraphSnapshot,
  TaskPlanInput,
  TaskPlanResult,
  TaskTodoOp,
  TaskTodoSummary,
} from "./common.ts";
import {
  addTaskLookup,
  applyTaskTodoOps,
  assertAcyclic,
  assertTaskName,
  assertUniqueTaskName,
  attributionFromTask,
  claimExpiresAt,
  claimScopeForInput,
  claimScopeForStoredClaim,
  cloneTask,
  cloneTaskRun,
  cloneTodos,
  isExpiredClaim,
  isOpenContextTask,
  isUnfinishedTaskStatus,
  materializeTodos,
  normalizeProject,
  normalizeProjectStatus,
  normalizeRoleRef,
  normalizeTask,
  normalizeTaskCancellation,
  normalizeTaskPlan,
  normalizeTaskRefs,
  normalizeTaskRun,
  normalizeTodo,
  normalizeTodos,
  summarizeTodos,
  taskLookup,
  taskNameFromTitle,
  taskPlanReadiness,
  uniqueTaskName,
} from "./internal.ts";

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
      purpose: input.purpose?.trim() || undefined,
      status: normalizeProjectStatus(input.status),
      outputLanguage: input.outputLanguage,
      roadmap: createDefaultProjectRoadmap(input.title, now),
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
            plan: normalizeTaskPlan(input.plan ?? existing.plan, description, title),
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
    patch: Partial<
      Pick<Project, "title" | "description" | "purpose" | "status" | "outputLanguage">
    >,
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
      purpose: patch.purpose !== undefined ? patch.purpose.trim() || undefined : project.purpose,
      status: normalizeProjectStatus(patch.status ?? project.status),
      outputLanguage: patch.outputLanguage ?? project.outputLanguage,
      updatedAt: nowIso(),
    };
    this.#projects.set(projectRef, updated);
    return updated;
  }

  replaceProjectRoadmap(projectRef: ProjectRef, roadmap: ProjectRoadmap): Project {
    const project = this.getProject(projectRef);
    const updated: Project = {
      ...project,
      roadmap: normalizeProjectRoadmap(roadmap, `project(${projectRef}).roadmap`),
      updatedAt: nowIso(),
    };
    this.#projects.set(projectRef, updated);
    return updated;
  }

  activateRoadmapItem(projectRef: ProjectRef, itemRef: RoadmapItemRef): Project {
    const project = this.getProject(projectRef);
    const roadmap = project.roadmap;
    const item = roadmap.items.find((candidate) => candidate.ref === itemRef);
    if (!item) throw new NotFoundError(`unknown roadmap item: ${itemRef}`);
    const now = nowIso();
    const updatedRoadmap: ProjectRoadmap = {
      ...roadmap,
      activeItemRef: itemRef,
      items: roadmap.items.map((candidate) =>
        candidate.ref === itemRef
          ? { ...candidate, status: "active" as const, updatedAt: now }
          : candidate,
      ),
      updatedAt: now,
    };
    return this.replaceProjectRoadmap(projectRef, updatedRoadmap);
  }

  attachRoadmapItemTaskRefs(
    projectRef: ProjectRef,
    itemRef: RoadmapItemRef,
    taskRefs: TaskRef[],
  ): RoadmapItem | undefined {
    const project = this.getProject(projectRef);
    const roadmap = project.roadmap;
    const itemIndex = roadmap.items.findIndex((candidate) => candidate.ref === itemRef);
    if (itemIndex < 0) return undefined;
    const item = roadmap.items[itemIndex]!;
    const now = nowIso();
    const updatedItem: RoadmapItem = {
      ...item,
      taskRefs: uniqueTaskRefs([...(item.taskRefs ?? []), ...taskRefs]),
      updatedAt: now,
    };
    const updatedItems = [...roadmap.items];
    updatedItems[itemIndex] = updatedItem;
    this.replaceProjectRoadmap(projectRef, { ...roadmap, items: updatedItems, updatedAt: now });
    return updatedItem;
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
