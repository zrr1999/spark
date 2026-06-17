import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "spark-store-v2");

async function loadJsonFixture(name: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(join(fixtureDir, name), "utf8")) as unknown;
  assertJsonObject(value, name);
  return value;
}

async function loadTextFixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), "utf8");
}

function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
}

function objectField(value: JsonObject, key: string): JsonObject {
  const field = value[key];
  assertJsonObject(field, key);
  return field;
}

function objectArrayField(value: JsonObject, key: string): JsonObject[] {
  const field = value[key];
  if (!Array.isArray(field)) assert.fail(`${key} must be an array`);
  for (const item of field) assertJsonObject(item, key);
  return field;
}

function stringArrayField(value: JsonObject, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field)) assert.fail(`${key} must be an array`);
  assert.equal(
    field.every((item: unknown) => typeof item === "string"),
    true,
    `${key} must contain strings`,
  );
  return field as string[];
}

void test("Spark store V2 manifest codifies hard cutover and import-only legacy paths", async () => {
  const manifest = await loadJsonFixture("manifest.json");

  assert.equal(manifest.version, 1);
  assert.equal(manifest.cutover, "hard");
  assert.equal(manifest.runtimeModeAfterMigration, "v2-only");

  const canonicalStores = objectArrayField(manifest, "canonicalStores");
  assert.deepEqual(
    canonicalStores.map((store) => store.path),
    [
      ".spark/todos/todos.sqlite",
      ".spark/sessions/<session>/",
      ".spark/projects/<project>/",
      ".spark/artifacts/",
    ],
  );
  assert.equal(
    canonicalStores.every((store) => store.kind === "canonical"),
    true,
  );

  const rebuildableIndexes = stringArrayField(manifest, "rebuildableIndexes");
  assert.deepEqual(rebuildableIndexes.sort(), [
    ".spark/cache/index.sqlite",
    ".spark/projects/index.json",
    ".spark/reviews/index.json",
    ".spark/sessions/index.json",
  ]);

  const legacyImportOnly = stringArrayField(manifest, "legacyImportOnly");
  assert.ok(legacyImportOnly.includes(".spark/projects.json"));
  assert.ok(legacyImportOnly.includes(".spark/todos/<session>.json"));
  assert.ok(legacyImportOnly.includes(".spark/review-gate.json"));
  assert.equal(
    canonicalStores.some((store) => legacyImportOnly.includes(String(store.path))),
    false,
  );

  assert.match(stringArrayField(manifest, "doctorRules").join("\n"), /must not dual-write/);
  assert.match(stringArrayField(manifest, "doctorRules").join("\n"), /falling back to V1/);
});

void test("Spark store V2 TODO SQLite schema is executable and enforces owner and status constraints", async () => {
  const schema = await loadTextFixture("todo-schema.sql");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{
      name: string;
    }>;
    assert.deepEqual(
      tables.map((row) => row.name),
      ["schema_meta", "todo_items"],
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as Array<{
      name: string;
    }>;
    assert.deepEqual(
      indexes.map((row) => row.name).filter((name) => name.startsWith("idx_todo_items_")),
      [
        "idx_todo_items_owner_status",
        "idx_todo_items_project_status",
        "idx_todo_items_task_status",
        "idx_todo_items_updated_at",
      ],
    );

    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'spark_store_v2_todo_schema_version'")
      .get() as { value: string } | undefined;
    assert.equal(version?.value, "1");

    db.prepare(
      `INSERT INTO todo_items
        (id, owner_kind, owner_ref, project_ref, task_ref, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "todo-task-1",
      "task",
      "task:demo",
      "proj:demo",
      "task:demo",
      "Ship contract fixtures",
      "pending",
      "2026-06-17T00:00:00.000Z",
      "2026-06-17T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO todo_items
        (id, owner_kind, owner_ref, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "todo-session-1",
      "session",
      "session:demo",
      "Sweep session notes",
      "in_progress",
      "2026-06-17T00:00:00.000Z",
      "2026-06-17T00:00:00.000Z",
    );

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_items
            (id, owner_kind, owner_ref, content, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "todo-invalid-status",
            "session",
            "session:demo",
            "Invalid status",
            "open",
            "2026-06-17T00:00:00.000Z",
            "2026-06-17T00:00:00.000Z",
          ),
      /constraint failed/i,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_items
            (id, owner_kind, owner_ref, task_ref, content, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "todo-invalid-owner",
            "session",
            "session:demo",
            "task:demo",
            "Session rows must not attach task_ref",
            "pending",
            "2026-06-17T00:00:00.000Z",
            "2026-06-17T00:00:00.000Z",
          ),
      /constraint failed/i,
    );
  } finally {
    db.close();
  }
});

void test("Spark store V2 sessions index fixture is rebuildable and points at per-session truth", async () => {
  const index = await loadJsonFixture("sessions-index.json");
  assert.equal(index.version, 1);
  assert.equal(index.rebuildable, true);
  assert.equal(index.source, "per-session-directories");

  const [session] = objectArrayField(index, "sessions");
  assert.ok(session);
  assert.equal(session.sessionKey, "session:demo");
  assert.equal(session.path, "sessions/session-demo");
  assert.equal(session.statePath, "sessions/session-demo/state.json");
  assert.equal(session.goalPath, "sessions/session-demo/goal.json");
  assert.equal(session.loopPath, "sessions/session-demo/loop.json");
  assert.equal(session.todoOwnerRef, session.sessionKey);
  assert.equal(String(session.path).endsWith(".json"), false, "sessions must be directories in V2");
  assert.ok(
    stringArrayField(index, "legacyImportOnly").includes(".spark/session-goals/<session>.json"),
  );
});

void test("Spark store V2 project/task tree fixture splits graph state and keeps TODOs external", async () => {
  const tree = await loadJsonFixture("project-task-tree.json");
  assert.equal(tree.version, 1);
  assert.equal(tree.cutover, "hard");
  assert.ok(stringArrayField(tree, "legacyImportOnly").includes(".spark/projects.json"));

  const projectsIndex = objectField(objectField(tree, "indexes"), "projects");
  assert.equal(projectsIndex.path, "projects/index.json");
  assert.equal(projectsIndex.rebuildable, true);

  const project = objectField(tree, "project");
  assert.equal(project.path, "projects/proj-demo/project.json");
  const projectValue = objectField(project, "value");
  assert.equal(projectValue.roadmapPath, "roadmap.json");
  assert.equal(projectValue.dependenciesPath, "dependencies.json");
  assert.equal(projectValue.tasksPath, "tasks");

  const [task] = objectArrayField(tree, "tasks");
  assert.ok(task);
  assert.equal(task.path, "projects/proj-demo/tasks/task-demo/task.json");
  const taskValue = objectField(task, "value");
  assert.equal(taskValue.todoOwnerRef, "task:demo");
  assert.equal("todos" in taskValue, false, "task.json must not embed TODO bodies");
  assert.deepEqual(taskValue.outputArtifacts, ["artifact:curated-demo"]);

  const [run] = objectArrayField(tree, "runs");
  assert.ok(run);
  assert.equal(run.path, "projects/proj-demo/tasks/task-demo/runs/run-demo.json");
});

void test("Spark store V2 review fixture is subject-owned and keeps global review index rebuildable", async () => {
  const review = await loadJsonFixture("review-record.json");
  assert.equal(review.version, 1);
  assert.equal(review.policy, "required");
  assert.equal(review.status, "resolved");
  assert.equal(review.outcome, "approved");

  const subject = objectField(review, "subject");
  assert.equal(subject.kind, "task");
  assert.equal(subject.ownerPath, "projects/proj-demo/tasks/task-demo/reviews/review-demo.json");
  assert.doesNotMatch(String(subject.ownerPath), /reviews\/gate\.json/);

  const indexProjection = objectField(review, "indexProjection");
  assert.equal(indexProjection.path, "reviews/index.json");
  assert.equal(indexProjection.rebuildable, true);
  const entry = objectField(indexProjection, "entry");
  assert.equal(entry.ownerPath, subject.ownerPath);

  assert.deepEqual(review.artifactRefs, ["artifact:review-demo"]);
  assert.ok(stringArrayField(review, "legacyImportOnly").includes(".spark/review-gate.json"));
});
