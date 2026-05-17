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
}

export interface CreateTaskTodoInput {
  content: string;
  status?: TaskTodoStatus;
  notes?: string[];
}

export interface CreateTaskInput {
  threadRef: ThreadRef;
  title: string;
  description: string;
  kind?: TaskKind;
  status?: Task["status"];
  agentRef?: AgentRef;
  inputArtifacts?: ArtifactRef[];
  todos?: CreateTaskTodoInput[];
}

export interface TaskTodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  blocked: number;
  cancelled: number;
  noteCount: number;
  active?: string;
}

export interface ThreadTodoSummary extends TaskTodoSummary {
  tasksWithTodos: number;
}

export interface TaskTodoOp {
  op: "init" | "append" | "start" | "done" | "block" | "cancel" | "remove" | "note";
  item?: string;
  items?: string[];
  text?: string;
}

export interface EnsureContextTaskInput {
  title?: string;
  description?: string;
  todos?: CreateTaskTodoInput[];
}

export interface TaskGraphSnapshot {
  threads: Thread[];
  tasks: Task[];
  dependencies: TaskDependency[];
  runs: TaskRun[];
}

export class TaskGraph {
  #threads = new Map<ThreadRef, Thread>();
  #tasks = new Map<TaskRef, Task>();
  #dependencies: TaskDependency[] = [];
  #runs = new Map<string, TaskRun>();

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
      inputArtifacts: input.inputArtifacts ?? [],
      outputArtifacts: [],
      todos: normalizeTodos(materializeTodos(input.todos ?? [], now)),
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.set(task.ref, task);
    const thread = this.getThread(task.threadRef);
    if (task.kind === "interaction" && !thread.currentTaskRef && isOpenContextTask(task)) {
      this.setCurrentTask(task.threadRef, task.ref);
      return this.getTask(task.ref);
    }
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
    const updated = { ...task, status, updatedAt: nowIso() };
    this.#tasks.set(taskRef, updated);
    if (this.getThread(task.threadRef).currentTaskRef === taskRef && !isOpenContextTask(updated)) {
      const replacement = this.findOpenContextTask(task.threadRef, taskRef);
      this.setCurrentTask(task.threadRef, replacement?.ref);
    }
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
    if (thread.currentTaskRef) {
      const current = this.#tasks.get(thread.currentTaskRef);
      if (current && current.threadRef === threadRef) return current;
    }
    return this.findOpenContextTask(threadRef);
  }

  ensureContextTask(threadRef: ThreadRef, input: EnsureContextTaskInput = {}): Task {
    this.getThread(threadRef);
    const existing = this.currentTask(threadRef);
    if (existing && isOpenContextTask(existing)) {
      if (!this.getThread(threadRef).currentTaskRef) this.setCurrentTask(threadRef, existing.ref);
      return existing;
    }
    const task = this.createTask({
      threadRef,
      title: input.title ?? "Maintain current interaction context",
      description:
        input.description ??
        "Track the active user interaction, unresolved clarification, and immediate next action for this Spark thread.",
      kind: "interaction",
      status: "running",
      todos: input.todos ?? [
        { content: "Clarify the current user intent" },
        { content: "Reflect the latest scope in Spark state" },
        { content: "Decide the next concrete action" },
      ],
    });
    this.setCurrentTask(threadRef, task.ref);
    return this.getTask(task.ref);
  }

  setTaskTodos(taskRef: TaskRef, todos: CreateTaskTodoInput[]): Task {
    const task = this.getTask(taskRef);
    const updated: Task = {
      ...task,
      todos: normalizeTodos(materializeTodos(todos, nowIso())),
      updatedAt: nowIso(),
    };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  applyTodoOps(taskRef: TaskRef, ops: TaskTodoOp[]): Task {
    if (ops.length === 0) throw new Error("todo ops are required");
    const task = this.getTask(taskRef);
    let todos = cloneTodos(task.todos);
    for (const op of ops) todos = applyTodoOp(todos, op);
    const updated: Task = {
      ...task,
      todos: normalizeTodos(todos),
      updatedAt: nowIso(),
    };
    this.#tasks.set(taskRef, updated);
    return updated;
  }

  todoSummary(taskRef: TaskRef): TaskTodoSummary {
    return summarizeTodos(this.getTask(taskRef).todos);
  }

  threadTodoSummary(threadRef: ThreadRef): ThreadTodoSummary {
    const tasks = this.tasks(threadRef);
    const allTodos = tasks.flatMap((task) => task.todos);
    return {
      ...summarizeTodos(allTodos),
      tasksWithTodos: tasks.filter((task) => task.todos.length > 0).length,
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
    ...task,
    inputArtifacts: task.inputArtifacts ?? [],
    outputArtifacts: task.outputArtifacts ?? [],
    todos: normalizeTodos((task.todos ?? []).map(normalizeTodo)),
  };
}

function normalizeTodo(todo: TaskTodo): TaskTodo {
  return {
    ...todo,
    notes: todo.notes ? [...todo.notes] : undefined,
    createdAt: todo.createdAt ?? nowIso(),
    updatedAt: todo.updatedAt ?? todo.createdAt ?? nowIso(),
  };
}

function materializeTodos(inputs: CreateTaskTodoInput[], now: string): TaskTodo[] {
  const seen = new Set<string>();
  return inputs.map((input) => {
    const content = input.content.trim();
    if (!content) throw new Error("todo content is required");
    if (seen.has(content)) throw new Error(`duplicate todo content: ${content}`);
    seen.add(content);
    return {
      content,
      status: input.status ?? "pending",
      notes: input.notes?.length ? [...input.notes] : undefined,
      createdAt: now,
      updatedAt: now,
    } satisfies TaskTodo;
  });
}

function cloneTodos(todos: TaskTodo[]): TaskTodo[] {
  return todos.map((todo) => ({
    ...todo,
    notes: todo.notes ? [...todo.notes] : undefined,
  }));
}

function normalizeTodos(todos: TaskTodo[]): TaskTodo[] {
  const next = cloneTodos(todos);
  const inProgress = next.filter((todo) => todo.status === "in_progress");
  if (inProgress.length > 1) {
    for (const todo of inProgress.slice(1)) {
      todo.status = "pending";
      todo.updatedAt = nowIso();
    }
  }
  if (next.some((todo) => todo.status === "in_progress")) return next;
  const firstPending = next.find((todo) => todo.status === "pending");
  if (firstPending) {
    firstPending.status = "in_progress";
    firstPending.updatedAt = nowIso();
  }
  return next;
}

function applyTodoOp(todos: TaskTodo[], op: TaskTodoOp): TaskTodo[] {
  const now = nowIso();
  switch (op.op) {
    case "init":
      if (!op.items?.length) throw new Error("todo init items are required");
      return materializeTodos(
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
        next.push({ content: trimmed, status: "pending", createdAt: now, updatedAt: now });
      }
      return next;
    }
    case "start": {
      const target = resolveTodo(todos, op.item, "todo item is required for start");
      const next = cloneTodos(todos);
      for (const todo of next) {
        if (todo.status === "in_progress") {
          todo.status = "pending";
          todo.updatedAt = now;
        }
      }
      const current = next.find((todo) => todo.content === target.content)!;
      current.status = "in_progress";
      current.updatedAt = now;
      return next;
    }
    case "done":
      return patchTodoStatus(todos, op.item, "done", now, "todo item is required for done");
    case "block":
      return patchTodoStatus(todos, op.item, "blocked", now, "todo item is required for block");
    case "cancel":
      return patchTodoStatus(todos, op.item, "cancelled", now, "todo item is required for cancel");
    case "remove": {
      const target = resolveTodo(todos, op.item, "todo item is required for remove");
      return cloneTodos(todos).filter((todo) => todo.content !== target.content);
    }
    case "note": {
      const target = resolveTodo(todos, op.item, "todo item is required for note");
      const text = op.text?.trimEnd();
      if (!text) throw new Error("todo note text is required");
      const next = cloneTodos(todos);
      const current = next.find((todo) => todo.content === target.content)!;
      current.notes = current.notes ? [...current.notes, text] : [text];
      current.updatedAt = now;
      return next;
    }
  }
}

function patchTodoStatus(
  todos: TaskTodo[],
  item: string | undefined,
  status: TaskTodoStatus,
  now: string,
  missingMessage: string,
): TaskTodo[] {
  const target = resolveTodo(todos, item, missingMessage);
  return cloneTodos(todos).map((todo) =>
    todo.content === target.content ? { ...todo, status, updatedAt: now } : todo,
  );
}

function resolveTodo(
  todos: TaskTodo[],
  item: string | undefined,
  missingMessage: string,
): TaskTodo {
  const content = item?.trim();
  if (!content) throw new Error(missingMessage);
  const target = todos.find((todo) => todo.content === content);
  if (!target) throw new NotFoundError(`unknown todo item: ${content}`);
  return target;
}

function summarizeTodos(todos: TaskTodo[]): TaskTodoSummary {
  return {
    total: todos.length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    done: todos.filter((todo) => todo.status === "done").length,
    blocked: todos.filter((todo) => todo.status === "blocked").length,
    cancelled: todos.filter((todo) => todo.status === "cancelled").length,
    noteCount: todos.reduce((sum, todo) => sum + (todo.notes?.length ?? 0), 0),
    active: todos.find((todo) => todo.status === "in_progress")?.content,
  };
}

function isOpenContextTask(task: Task): boolean {
  return !["done", "failed", "cancelled"].includes(task.status);
}
