import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { nowIso } from "@zendev-lab/pi-extension-api";
import {
  TaskGraph,
  TaskGraphStore,
  defaultTaskGraphStore,
  defaultTaskTodoStore,
} from "@zendev-lab/pi-tasks";
import { normalizeCurrentProjectStoreSnapshot } from "./current-project-state-schema.ts";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import { rebuildSessionIndex } from "./session-directory-store.ts";
import { rebuildWorkspaceReviewIndex } from "./subject-review-store.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export const STORE_V2_CUTOVER_MARKER_RELATIVE_PATH = ".spark/store-v2-cutover.json";

export interface StoreV2MigrationAction {
  kind:
    | "backup-legacy"
    | "import-project-graph"
    | "import-task-todos"
    | "import-session-todos"
    | "import-session-state"
    | "import-session-goal"
    | "import-session-loop"
    | "import-todo-display-numbers"
    | "import-hidden-role-run-inbox"
    | "rebuild-index"
    | "validate-invariants"
    | "record-cutover-marker";
  path?: string;
  target?: string;
  imported?: number;
  status: "planned" | "applied" | "skipped";
  reason?: string;
}

export interface StoreV2CutoverMarker {
  version: 1;
  storeVersion: "v2";
  cutover: "hard";
  runtimeModeAfterMigration: "v2-only";
  status: "complete";
  completedAt: string;
  backupDir?: string;
  legacyImportOnly: string[];
  actions: Array<Omit<StoreV2MigrationAction, "status"> & { status: "applied" | "skipped" }>;
}

export interface StoreV2MigrationResult {
  dryRun: boolean;
  backupDir?: string;
  actions: StoreV2MigrationAction[];
  legacyImportOnly: string[];
  cutoverMarkerPath?: string;
}

export function storeV2CutoverMarkerPath(cwd: string): string {
  return join(cwd, STORE_V2_CUTOVER_MARKER_RELATIVE_PATH);
}

export async function migrateStoreV2(
  cwd: string,
  ctx: SparkToolContext,
  options: { dryRun: boolean },
): Promise<StoreV2MigrationResult> {
  const legacyPaths = await existingLegacyImportOnlyPaths(cwd);
  const actions = await planStoreV2MigrationActions(cwd, legacyPaths);
  const backupDir = legacyPaths.length
    ? join(".spark", "backups", `store-v2-${new Date().toISOString().replace(/[:.]/gu, "-")}`)
    : undefined;

  if (options.dryRun)
    return {
      dryRun: true,
      backupDir,
      actions,
      legacyImportOnly: legacyPaths,
      cutoverMarkerPath: STORE_V2_CUTOVER_MARKER_RELATIVE_PATH,
    };

  if (backupDir) await backupLegacyPaths(cwd, legacyPaths, backupDir);
  for (const action of actions)
    await applyMigrationAction(cwd, ctx, action, {
      actions,
      backupDir,
      legacyImportOnly: legacyPaths,
    });
  return {
    dryRun: false,
    backupDir,
    actions,
    legacyImportOnly: legacyPaths,
    cutoverMarkerPath: STORE_V2_CUTOVER_MARKER_RELATIVE_PATH,
  };
}

async function planStoreV2MigrationActions(
  cwd: string,
  legacyPaths: string[],
): Promise<StoreV2MigrationAction[]> {
  const actions: StoreV2MigrationAction[] = [];
  for (const path of legacyPaths)
    actions.push({ kind: "backup-legacy", path, target: undefined, status: "planned" });
  if (await exists(join(cwd, ".spark", "projects.json")))
    actions.push({
      kind: "import-project-graph",
      path: ".spark/projects.json",
      target: ".spark/projects/",
      status: "planned",
    });
  for (const path of await legacyTaskTodoFiles(cwd))
    actions.push({
      kind: "import-task-todos",
      path,
      target: ".spark/todos/todos.sqlite",
      status: "planned",
    });
  for (const path of await legacySessionTodoFiles(cwd))
    actions.push({
      kind: "import-session-todos",
      path,
      target: ".spark/todos/todos.sqlite",
      status: "planned",
    });
  for (const path of await legacyFlatSessionStateFiles(cwd))
    actions.push({
      kind: "import-session-state",
      path,
      target: sessionTargetPath(path, "state.json"),
      status: "planned",
    });
  for (const path of await legacySessionGoalFiles(cwd))
    actions.push({
      kind: "import-session-goal",
      path,
      target: sessionTargetPath(path, "goal.json"),
      status: "planned",
    });
  for (const path of await legacySessionLoopFiles(cwd))
    actions.push({
      kind: "import-session-loop",
      path,
      target: sessionTargetPath(path, "loop.json"),
      status: "planned",
    });
  for (const path of await legacyTodoDisplayNumberFiles(cwd))
    actions.push({
      kind: "import-todo-display-numbers",
      path,
      target: sessionTargetPath(path, "todo-display-numbers.json"),
      status: "planned",
    });
  for (const path of await legacyHiddenRoleRunInboxFiles(cwd))
    actions.push({
      kind: "import-hidden-role-run-inbox",
      path,
      target: sessionTargetPath(path, "hidden-role-run-inbox.json"),
      status: "planned",
    });
  actions.push(
    { kind: "rebuild-index", target: ".spark/projects/index.json", status: "planned" },
    { kind: "rebuild-index", target: ".spark/sessions/index.json", status: "planned" },
    { kind: "rebuild-index", target: ".spark/reviews/index.json", status: "planned" },
    { kind: "validate-invariants", target: ".spark", status: "planned" },
    {
      kind: "record-cutover-marker",
      target: STORE_V2_CUTOVER_MARKER_RELATIVE_PATH,
      status: "planned",
    },
  );
  return actions;
}

async function applyMigrationAction(
  cwd: string,
  _ctx: SparkToolContext,
  action: StoreV2MigrationAction,
  migration: { actions: StoreV2MigrationAction[]; backupDir?: string; legacyImportOnly: string[] },
): Promise<void> {
  switch (action.kind) {
    case "backup-legacy":
      action.status = "applied";
      return;
    case "import-project-graph": {
      const graph = await new TaskGraphStore(join(cwd, ".spark", "projects.json")).load();
      if (!graph) {
        action.status = "skipped";
        action.reason = "legacy projects.json not found";
        return;
      }
      await defaultTaskGraphStore(cwd).save(TaskGraph.fromSnapshot(graph.snapshot()));
      action.status = "applied";
      return;
    }
    case "import-task-todos": {
      if (!action.path) return;
      const result = await defaultTaskTodoStore(cwd, "migration").importLegacyTaskTodoFile(
        join(cwd, action.path),
      );
      action.imported = result.imported;
      action.status = result.found ? "applied" : "skipped";
      return;
    }
    case "import-session-todos": {
      if (!action.path) return;
      const ownerRef = basename(action.path, ".json");
      const result = await defaultTaskTodoStore(cwd, "migration").importLegacySessionTodoFile(
        ownerRef,
        join(cwd, action.path),
      );
      action.imported = result.imported;
      action.status = result.found ? "applied" : "skipped";
      return;
    }
    case "import-session-state":
      if (!action.path) return;
      await importLegacyFlatSessionStateFile(cwd, action.path);
      action.status = "applied";
      return;
    case "import-session-goal":
      if (!action.path) return;
      await copyLegacySessionJsonFile(cwd, action.path, "goal.json");
      action.status = "applied";
      return;
    case "import-session-loop":
      if (!action.path) return;
      await copyLegacySessionJsonFile(cwd, action.path, "loop.json");
      action.status = "applied";
      return;
    case "import-todo-display-numbers":
      if (!action.path) return;
      await copyLegacySessionJsonFile(cwd, action.path, "todo-display-numbers.json");
      action.status = "applied";
      return;
    case "import-hidden-role-run-inbox":
      if (!action.path) return;
      await copyLegacySessionJsonFile(cwd, action.path, "hidden-role-run-inbox.json");
      action.status = "applied";
      return;
    case "rebuild-index": {
      if (action.target === ".spark/projects/index.json") {
        const graph = await defaultTaskGraphStore(cwd).load();
        if (graph) await defaultTaskGraphStore(cwd).save(graph);
      } else if (action.target === ".spark/sessions/index.json") {
        await rebuildSessionIndex(cwd);
      } else if (action.target === ".spark/reviews/index.json") {
        await rebuildWorkspaceReviewIndex(cwd);
      }
      action.status = "applied";
      return;
    }
    case "validate-invariants":
      await validateStoreV2Invariants(cwd);
      action.status = "applied";
      return;
    case "record-cutover-marker":
      await writeStoreV2CutoverMarker(cwd, migration);
      action.status = "applied";
      return;
  }
}

async function importLegacyFlatSessionStateFile(cwd: string, relativePath: string): Promise<void> {
  const legacyPath = join(cwd, relativePath);
  const raw = await readJsonFileOptional<Record<string, unknown>>(legacyPath);
  if (!raw) return;
  const snapshot = normalizeCurrentProjectStoreSnapshot(raw, legacyPath);
  await writeJsonFileAtomic(join(cwd, sessionTargetPath(relativePath, "state.json")), snapshot);
  await rebuildSessionIndex(cwd);
}

async function copyLegacySessionJsonFile(
  cwd: string,
  relativePath: string,
  targetName: string,
): Promise<void> {
  const raw = await readJsonFileOptional<Record<string, unknown>>(join(cwd, relativePath));
  if (!raw) return;
  await writeJsonFileAtomic(join(cwd, sessionTargetPath(relativePath, targetName)), raw);
  await rebuildSessionIndex(cwd);
}

async function validateStoreV2Invariants(cwd: string): Promise<void> {
  if (await exists(join(cwd, ".spark", "projects")))
    await requireExistingPath(cwd, ".spark/projects/index.json");
  await requireExistingPath(cwd, ".spark/sessions/index.json");
  await requireExistingPath(cwd, ".spark/reviews/index.json");
}

async function requireExistingPath(cwd: string, relativePath: string): Promise<void> {
  if (await exists(join(cwd, relativePath))) return;
  throw new Error(`Store V2 invariant failed: missing ${relativePath}`);
}

async function writeStoreV2CutoverMarker(
  cwd: string,
  migration: { actions: StoreV2MigrationAction[]; backupDir?: string; legacyImportOnly: string[] },
): Promise<void> {
  const marker: StoreV2CutoverMarker = {
    version: 1,
    storeVersion: "v2",
    cutover: "hard",
    runtimeModeAfterMigration: "v2-only",
    status: "complete",
    completedAt: nowIso(),
    ...(migration.backupDir ? { backupDir: migration.backupDir } : {}),
    legacyImportOnly: migration.legacyImportOnly,
    actions: migration.actions
      .filter((action) => action.kind !== "record-cutover-marker")
      .map((action) => ({
        ...action,
        status: action.status === "planned" ? "skipped" : action.status,
      })),
  };
  await writeJsonFileAtomic(storeV2CutoverMarkerPath(cwd), marker);
}

async function backupLegacyPaths(
  cwd: string,
  legacyPaths: string[],
  backupDir: string,
): Promise<void> {
  for (const legacy of legacyPaths) {
    const from = join(cwd, legacy);
    const to = join(cwd, backupDir, legacy.replace(/^\.spark\//u, ""));
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, force: true, errorOnExist: false });
  }
}

export async function existingLegacyImportOnlyPaths(cwd: string): Promise<string[]> {
  const candidates = [
    ".spark/projects.json",
    ".spark/projects.json.lock",
    ".spark/todos.json",
    ".spark/review-gate.json",
  ];
  const existing = [
    ...candidates,
    ...(await legacyTaskTodoFiles(cwd)),
    ...(await legacyFlatSessionStateFiles(cwd)),
    ...(await legacySessionGoalFiles(cwd)),
    ...(await legacySessionLoopFiles(cwd)),
    ...(await legacySessionTodoFiles(cwd)),
    ...(await legacyTodoDisplayNumberFiles(cwd)),
    ...(await legacyHiddenRoleRunInboxFiles(cwd)),
  ];
  const found: string[] = [];
  for (const path of existing) if (await exists(join(cwd, path))) found.push(path);
  return [...new Set(found)].sort();
}

async function legacyTaskTodoFiles(cwd: string): Promise<string[]> {
  return legacyJsonFiles(join(cwd, ".spark", "todos"), ".spark/todos");
}

async function legacyFlatSessionStateFiles(cwd: string): Promise<string[]> {
  return legacyJsonFiles(join(cwd, ".spark", "sessions"), ".spark/sessions");
}

async function legacySessionGoalFiles(cwd: string): Promise<string[]> {
  return legacyJsonFiles(join(cwd, ".spark", "session-goals"), ".spark/session-goals");
}

async function legacySessionLoopFiles(cwd: string): Promise<string[]> {
  return legacyJsonFiles(join(cwd, ".spark", "session-loops"), ".spark/session-loops");
}

async function legacySessionTodoFiles(cwd: string): Promise<string[]> {
  return legacyJsonFiles(join(cwd, ".spark", "session-todos"), ".spark/session-todos");
}

async function legacyTodoDisplayNumberFiles(cwd: string): Promise<string[]> {
  return legacyJsonFiles(
    join(cwd, ".spark", "todo-display-numbers"),
    ".spark/todo-display-numbers",
  );
}

async function legacyHiddenRoleRunInboxFiles(cwd: string): Promise<string[]> {
  return legacyJsonFiles(
    join(cwd, ".spark", "background-role-results-inbox"),
    ".spark/background-role-results-inbox",
  );
}

async function legacyJsonFiles(root: string, relativeRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => `${relativeRoot}/${entry.name}`)
    .sort();
}

function sessionTargetPath(relativePath: string, targetName: string): string {
  const owner = basename(relativePath, ".json");
  return join(".spark", "sessions", owner, targetName);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
