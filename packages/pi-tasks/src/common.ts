import type {
  ArtifactRef,
  Project,
  ProjectRef,
  ProjectStatus,
  RoleRef,
  RunRef,
  Task,
  TaskAttribution,
  TaskCancellation,
  TaskClaim,
  TaskClaimKind,
  TaskDependency,
  TaskKind,
  TaskPlan,
  TaskPlanIssue,
  TaskRef,
  TaskRun,
  TaskTodo,
  TaskTodoStatus,
} from "@zendev-lab/pi-extension-api";

export interface CreateProjectInput {
  title: string;
  description: string;
  purpose?: string;
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
    | "upsert_done"
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

export type TaskTodoStoreEntry = Pick<TaskTodo, "taskRef" | "content" | "status"> &
  Partial<TaskTodo>;

export interface LoadableTaskTodoStoreSnapshot {
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
