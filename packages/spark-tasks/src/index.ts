import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type AgentRegistry, runAgentInstructionOnly } from "spark-agents";
import type { ArtifactStore } from "spark-artifacts";
import {
  DependencyError,
  NotFoundError,
  type AgentRef,
  type ArtifactRef,
  type JsonValue,
  type Task,
  type TaskDependency,
  type TaskKind,
  type TaskProposal,
  type TaskRef,
  type TaskRun,
  type TaskTodo,
  type TaskTodoStatus,
  type Thread,
  type ThreadRef,
  newRef,
  nowIso,
} from "spark-core";

export interface CreateThreadInput {
  title: string;
  description: string;
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
  threadRef: ThreadRef;
  title: string;
  description: string;
  kind?: TaskKind;
  status?: Task["status"];
  agentRef?: AgentRef;
  claimedBySession?: string;
  inputArtifacts?: ArtifactRef[];
  /**
   * Seed durable TODOs for this task. TaskGraphStore intentionally keeps TODOs
   * out of thread.json; persist them through TaskTodoStore.
   */
  todos?: CreateTaskTodoInput[];
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

export interface ThreadTodoSummary extends TaskTodoSummary {
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

export interface TaskGraphSnapshot {
  threads: Thread[];
  tasks: Task[];
  dependencies: TaskDependency[];
  runs: TaskRun[];
}

export interface TaskPlanInput {
  title: string;
  description: string;
  kind?: TaskKind;
  status?: Task["status"];
  agentRef?: AgentRef;
  dependsOn?: Array<TaskRef | string>;
  rationale?: string;
}

export interface TaskPlanResult {
  created: Task[];
  updated: Task[];
  skipped: Task[];
  dependencies: TaskDependency[];
}

export interface TaskTodoStoreSnapshot {
  version: 1;
  todos: TaskTodo[];
}

export class TaskGraph {
  #threads = new Map<ThreadRef, Thread>();
  #tasks = new Map<TaskRef, Task>();
  #dependencies: TaskDependency[] = [];
  #runs = new Map<string, TaskRun>();
  #todos = new Map<TaskRef, TaskTodo[]>();

  static fromSnapshot(snapshot: TaskGraphSnapshot): TaskGraph {
    const graph = new TaskGraph();
    for (const thread of snapshot.threads) graph.#threads.set(thread.ref, normalizeThread(thread));
    for (const task of snapshot.tasks) graph.#tasks.set(task.ref, normalizeTask(task));
    graph.#dependencies = snapshot.dependencies ?? [];
    for (const run of snapshot.runs ?? []) graph.#runs.set(run.ref, run);
    return graph;
  }

  snapshot(): TaskGraphSnapshot {
    return {
      threads: this.threads(),
      tasks: this.tasks(),
      dependencies: this.dependencies(),
      runs: this.runs(),
    };
  }

  createThread(input: CreateThreadInput): Thread {
    if (!input.title.trim()) throw new Error("thread title is required");
    const now = nowIso();
    const thread: Thread = {
      ref: newRef("thread"),
      title: input.title,
      description: input.description,
      outputLanguage: input.outputLanguage,
      createdAt: now,
      updatedAt: now,
    };
    this.#threads.set(thread.ref, thread);
    return thread;
  }

  createTask(input: CreateTaskInput): Task {
    this.getThread(input.threadRef);
    if (!input.title.trim()) throw new Error("task title is required");
    const now = nowIso();
    const task: Task = {
      ref: newRef("task"),
      threadRef: input.threadRef,
      title: input.title,
      description: input.description,
      kind: input.kind ?? "generic",
      status:
        input.status ??
        (input.kind === "interaction" ? "running" : input.agentRef ? "pending" : "proposed"),
      agentRef: input.agentRef,
      claimedBySession: input.claimedBySession,
      inputArtifacts: input.inputArtifacts ?? [],
      outputArtifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.set(task.ref, task);
    this.#todos.set(task.ref, normalizeTodos(materializeTodos(task.ref, input.todos ?? [], now)));
    return task;
  }

  acceptProposal(proposal: TaskProposal): Task {
    const task = this.createTask({
      threadRef: proposal.threadRef,
      title: proposal.title,
      description: proposal.description,
      kind: proposal.kind,
      agentRef: proposal.proposedAgentRef,
    });
    for (const dep of proposal.dependsOn ?? []) this.addDependency(task.ref, dep);
    return task;
  }

  planTasks(threadRef: ThreadRef, inputs: TaskPlanInput[]): TaskPlanResult {
    this.getThread(threadRef);
    const created: Task[] = [];
    const updated: Task[] = [];
    const skipped: Task[] = [];
    const dependencies: TaskDependency[] = [];
    const refsByTitle = new Map(this.tasks(threadRef).map((task) => [task.title, task.ref]));
    for (const input of inputs) {
      const title = input.title.trim();
      const description = input.description.trim();
      if (!title) throw new Error("task title is required");
      if (!description) throw new Error(`task description is required: ${title}`);
      const existing = this.tasks(threadRef).find((task) => task.title === title);
      const task = existing
        ? this.updateTask(existing.ref, {
            title,
            description,
            kind: input.kind ?? existing.kind,
            status: input.status ?? existing.status,
            agentRef: input.agentRef ?? existing.agentRef,
          })
        : this.createTask({
            threadRef,
            title,
            description,
            kind: input.kind,
            status: input.status,
            agentRef: input.agentRef,
          });
      if (existing) updated.push(task);
      else created.push(task);
      refsByTitle.set(title, task.ref);
    }

    for (const input of inputs) {
      const taskRef = refsByTitle.get(input.title.trim());
      if (!taskRef) continue;
      for (const dep of input.dependsOn ?? []) {
        const depRef = refsByTitle.get(dep) ?? dep;
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

  bindAgent(taskRef: TaskRef, agentRef: AgentRef): Task {
    const task = this.getTask(taskRef);
    const updated: Task = {
      ...task,
      agentRef,
      status: task.status === "proposed" ? "pending" : task.status,
      updatedAt: nowIso(),
    };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  setTaskStatus(taskRef: TaskRef, status: Task["status"]): Task {
    const task = this.getTask(taskRef);
    const updated = {
      ...task,
      status,
      claimedBySession: isUnfinishedTaskStatus(status) ? task.claimedBySession : undefined,
      updatedAt: nowIso(),
    };
    this.#tasks.set(taskRef, updated);
    if (this.getThread(task.threadRef).currentTaskRef === taskRef && !isOpenContextTask(updated)) {
      const replacement = this.findOpenContextTask(task.threadRef, taskRef);
      this.setCurrentTask(task.threadRef, replacement?.ref);
    }
    return updated;
  }

  updateTask(
    taskRef: TaskRef,
    patch: Partial<
      Pick<Task, "title" | "description" | "kind" | "status" | "agentRef" | "claimedBySession">
    >,
  ): Task {
    const task = this.getTask(taskRef);
    const status = patch.status ?? task.status;
    const updated: Task = {
      ...task,
      title: patch.title ?? task.title,
      description: patch.description ?? task.description,
      kind: patch.kind ?? task.kind,
      status,
      agentRef: patch.agentRef ?? task.agentRef,
      claimedBySession: isUnfinishedTaskStatus(status)
        ? (patch.claimedBySession ?? task.claimedBySession)
        : undefined,
      updatedAt: nowIso(),
    };
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

  setCurrentTask(threadRef: ThreadRef, taskRef?: TaskRef): Thread {
    const thread = this.getThread(threadRef);
    if (taskRef) {
      const task = this.getTask(taskRef);
      if (task.threadRef !== threadRef)
        throw new DependencyError("current task must belong to thread");
    }
    const updated: Thread = {
      ...thread,
      currentTaskRef: taskRef,
      updatedAt: nowIso(),
    };
    this.#threads.set(threadRef, updated);
    return updated;
  }

  currentTask(threadRef: ThreadRef): Task | undefined {
    const thread = this.getThread(threadRef);
    if (!thread.currentTaskRef) return undefined;
    const current = this.#tasks.get(thread.currentTaskRef);
    if (current && current.threadRef === threadRef) return current;
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
    let todos = this.taskTodos(taskRef);
    for (const op of ops) todos = applyTodoOp(taskRef, todos, op);
    this.#todos.set(taskRef, normalizeTodos(todos));
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

  threadTodoSummary(threadRef: ThreadRef): ThreadTodoSummary {
    const tasks = this.tasks(threadRef);
    const allTodos = tasks.flatMap((task) => this.taskTodos(task.ref));
    return {
      ...summarizeTodos(allTodos),
      tasksWithTodos: tasks.filter((task) => this.taskTodos(task.ref).length > 0).length,
    };
  }

  addDependency(taskRef: TaskRef, dependsOn: TaskRef): TaskDependency {
    const task = this.getTask(taskRef);
    const prerequisite = this.getTask(dependsOn);
    if (task.threadRef !== prerequisite.threadRef)
      throw new DependencyError("task dependencies cannot cross threads");
    if (taskRef === dependsOn) throw new DependencyError("task cannot depend on itself");
    const dependency = { taskRef, dependsOn };
    if (this.#dependencies.some((dep) => dep.taskRef === taskRef && dep.dependsOn === dependsOn))
      return dependency;
    const next = [...this.#dependencies, dependency];
    assertAcyclic(next);
    this.#dependencies = next;
    return dependency;
  }

  readyTasks(threadRef?: ThreadRef): Task[] {
    const tasks = this.tasks(threadRef);
    const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.ref));
    return tasks.filter((task) => {
      if (task.status !== "pending" && task.status !== "ready") return false;
      if (!task.agentRef) return false;
      return this.#dependencies
        .filter((dep) => dep.taskRef === task.ref)
        .every((dep) => done.has(dep.dependsOn));
    });
  }

  enqueueReadyTasks(threadRef?: ThreadRef): Task[] {
    return this.readyTasks(threadRef).map((task) => this.setTaskStatus(task.ref, "ready"));
  }

  async runTask(input: {
    taskRef: TaskRef;
    registry: AgentRegistry;
    artifactStore?: ArtifactStore;
    cwd?: string;
    dryRun?: boolean;
  }): Promise<TaskRun> {
    const task = this.getTask(input.taskRef);
    if (!task.agentRef) throw new DependencyError(`task has no agent binding: ${task.ref}`);
    const unmet = this.#dependencies.filter(
      (dep) => dep.taskRef === task.ref && this.getTask(dep.dependsOn).status !== "done",
    );
    if (unmet.length > 0) throw new DependencyError(`task has unmet dependencies: ${task.ref}`);

    this.setTaskStatus(task.ref, "running");
    const run: TaskRun = {
      ref: newRef("run"),
      threadRef: task.threadRef,
      taskRef: task.ref,
      agentRef: task.agentRef,
      status: "running",
      startedAt: nowIso(),
      outputArtifacts: [],
    };
    this.#runs.set(run.ref, run);

    try {
      const result = await runAgentInstructionOnly(
        input.registry,
        {
          agentRef: task.agentRef,
          instruction: task.description,
          inputs: task.inputArtifacts,
        },
        { cwd: input.cwd ?? process.cwd(), dryRun: input.dryRun ?? true },
      );

      let outputArtifactRef: ArtifactRef | undefined;
      if (input.artifactStore) {
        const artifact = await input.artifactStore.put({
          kind: "agent-run",
          title: `Agent run for ${task.title}`,
          format: "json",
          body: {
            record: result.record,
            stdout: result.stdout,
            stderr: result.stderr,
            jsonEvents: result.jsonEvents,
          } as unknown as JsonValue,
          provenance: {
            producer: "task",
            threadRef: task.threadRef,
            taskRef: task.ref,
            agentRef: task.agentRef,
          },
        });
        outputArtifactRef = artifact.ref;
        this.attachOutputArtifact(task.ref, artifact.ref);
      }

      const succeeded =
        result.record.status === "succeeded" || result.record.status === "not_started";
      const finished: TaskRun = {
        ...run,
        status: succeeded ? "succeeded" : "failed",
        finishedAt: nowIso(),
        outputArtifacts: outputArtifactRef ? [outputArtifactRef] : [],
      };
      this.#runs.set(finished.ref, finished);
      this.setTaskStatus(task.ref, succeeded ? "done" : "failed");
      return finished;
    } catch (error) {
      const failed: TaskRun = {
        ...run,
        status: "failed",
        finishedAt: nowIso(),
        outputArtifacts: [],
      };
      this.#runs.set(failed.ref, failed);
      this.setTaskStatus(task.ref, "failed");
      throw error;
    }
  }

  getThread(ref: ThreadRef): Thread {
    const thread = this.#threads.get(ref);
    if (!thread) throw new NotFoundError(`unknown thread: ${ref}`);
    return thread;
  }

  updateThread(
    threadRef: ThreadRef,
    patch: Partial<Pick<Thread, "title" | "description" | "outputLanguage">>,
  ): Thread {
    const thread = this.getThread(threadRef);
    const title = patch.title ?? thread.title;
    const description = patch.description ?? thread.description;
    if (!title.trim()) throw new Error("thread title is required");
    if (!description.trim()) throw new Error("thread description is required");
    const updated: Thread = {
      ...thread,
      title,
      description,
      outputLanguage: patch.outputLanguage ?? thread.outputLanguage,
      updatedAt: nowIso(),
    };
    this.#threads.set(threadRef, updated);
    return updated;
  }

  getTask(ref: TaskRef): Task {
    const task = this.#tasks.get(ref);
    if (!task) throw new NotFoundError(`unknown task: ${ref}`);
    return task;
  }

  threads(): Thread[] {
    return [...this.#threads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  tasks(threadRef?: ThreadRef): Task[] {
    return [...this.#tasks.values()]
      .filter((task) => !threadRef || task.threadRef === threadRef)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  dependencies(threadRef?: ThreadRef): TaskDependency[] {
    if (!threadRef) return [...this.#dependencies];
    const refs = new Set(this.tasks(threadRef).map((task) => task.ref));
    return this.#dependencies.filter((dep) => refs.has(dep.taskRef));
  }

  runs(threadRef?: ThreadRef): TaskRun[] {
    return [...this.#runs.values()]
      .filter((run) => !threadRef || run.threadRef === threadRef)
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  }

  findOpenContextTask(threadRef: ThreadRef, excludeTaskRef?: TaskRef): Task | undefined {
    return this.tasks(threadRef).find(
      (task) =>
        task.ref !== excludeTaskRef && task.kind === "interaction" && isOpenContextTask(task),
    );
  }
}

export class TaskGraphStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(graph: TaskGraph): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(graph.snapshot(), null, 2)}\n`, "utf8");
  }

  async load(): Promise<TaskGraph | null> {
    try {
      return TaskGraph.fromSnapshot(
        JSON.parse(await readFile(this.filePath, "utf8")) as TaskGraphSnapshot,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

export function defaultTaskGraphStore(cwd: string): TaskGraphStore {
  return new TaskGraphStore(join(cwd, ".spark", "thread.json"));
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
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  async load(): Promise<TaskTodo[] | null> {
    try {
      const raw = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<TaskTodoStoreSnapshot>;
      return (raw.todos ?? []).map(normalizeTodo);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async hydrate(graph: TaskGraph): Promise<boolean> {
    const todos = await this.load();
    if (!todos) return false;
    graph.hydrateTodos(todos);
    return true;
  }
}

export function defaultTaskTodoStore(cwd: string, scope?: string): TaskTodoStore {
  if (!scope) return new TaskTodoStore(join(cwd, ".spark", "todos.json"));
  return new TaskTodoStore(join(cwd, ".spark", "todos", `${sanitizeTodoStoreScope(scope)}.json`));
}

function sanitizeTodoStoreScope(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe || "default";
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

function normalizeThread(thread: Thread): Thread {
  return {
    ...thread,
    currentTaskRef: thread.currentTaskRef,
  };
}

function normalizeTask(task: Task): Task {
  return {
    ref: task.ref,
    threadRef: task.threadRef,
    title: task.title,
    description: task.description,
    kind: task.kind,
    status: task.status,
    agentRef: task.agentRef,
    claimedBySession: isUnfinishedTaskStatus(task.status) ? task.claimedBySession : undefined,
    inputArtifacts: task.inputArtifacts,
    outputArtifacts: task.outputArtifacts,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
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

function normalizeTodo(todo: TaskTodo): TaskTodo {
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
  const next = cloneTodos(todos);
  const live = next.filter((todo) => todo.status !== "deleted");
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

function applyTodoOp(taskRef: TaskRef, todos: TaskTodo[], op: TaskTodoOp): TaskTodo[] {
  const now = nowIso();
  switch (op.op) {
    case "init":
      if (!op.items?.length) throw new Error("todo init items are required");
      return materializeTodos(
        taskRef,
        op.items.map((content) => ({ content })),
        now,
      );
    case "append": {
      if (!op.items?.length) throw new Error("todo append items are required");
      const next = cloneTodos(todos);
      for (const content of op.items) {
        const trimmed = content.trim();
        if (!trimmed) throw new Error("todo content is required");
        if (next.some((todo) => todo.content === trimmed)) {
          throw new Error(`duplicate todo content: ${trimmed}`);
        }
        next.push({
          id: todoIdFromContent(trimmed, next.length),
          taskRef,
          content: trimmed,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        });
      }
      return next;
    }
    case "start": {
      const target = resolveTodo(todos, op, "todo item is required for start");
      const next = cloneTodos(todos);
      for (const todo of next) {
        if (todo.status === "in_progress") {
          todo.status = "pending";
          todo.updatedAt = now;
        }
      }
      const current = next.find((todo) => todo.id === target.id)!;
      current.status = "in_progress";
      current.updatedAt = now;
      return next;
    }
    case "done":
      return patchTodoStatus(todos, op, "done", now, "todo item is required for done");
    case "block":
      return patchTodoStatus(todos, op, "blocked", now, "todo item is required for block");
    case "cancel":
      return patchTodoStatus(todos, op, "cancelled", now, "todo item is required for cancel");
    case "delete":
    case "remove":
      return patchTodoStatus(todos, op, "deleted", now, "todo item is required for delete");
    case "restore": {
      const target = resolveTodo(todos, op, "todo item is required for restore", true);
      return cloneTodos(todos).map((todo) =>
        todo.id === target.id
          ? { ...todo, status: "pending", deletedAt: undefined, updatedAt: now }
          : todo,
      );
    }
    case "note": {
      const target = resolveTodo(todos, op, "todo item is required for note");
      const text = op.text?.trimEnd();
      if (!text) throw new Error("todo note text is required");
      const next = cloneTodos(todos);
      const current = next.find((todo) => todo.id === target.id)!;
      current.notes = current.notes ? [...current.notes, text] : [text];
      current.updatedAt = now;
      return next;
    }
  }
}

function patchTodoStatus(
  todos: TaskTodo[],
  op: Pick<TaskTodoOp, "id" | "item" | "blockedBy">,
  status: TaskTodoStatus,
  now: string,
  missingMessage: string,
): TaskTodo[] {
  const target = resolveTodo(todos, op, missingMessage);
  return cloneTodos(todos).map((todo) => {
    if (todo.id !== target.id) return todo;
    return {
      ...todo,
      status,
      blockedBy: status === "blocked" && op.blockedBy?.length ? [...op.blockedBy] : todo.blockedBy,
      deletedAt: status === "deleted" ? now : undefined,
      updatedAt: now,
    };
  });
}

function resolveTodo(
  todos: TaskTodo[],
  op: Pick<TaskTodoOp, "id" | "item">,
  missingMessage: string,
  includeDeleted = false,
): TaskTodo {
  const id = op.id?.trim();
  const content = op.item?.trim();
  if (!id && !content) throw new Error(missingMessage);
  const candidates = includeDeleted ? todos : todos.filter((todo) => todo.status !== "deleted");
  const target = id
    ? candidates.find((todo) => todo.id === id)
    : candidates.find((todo) => todo.content === content);
  if (!target) throw new NotFoundError(`unknown todo item: ${id ?? content}`);
  return target;
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
