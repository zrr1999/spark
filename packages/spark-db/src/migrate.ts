import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

const sourceMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const repoMigrationsDir = resolve(
  process.env.SPARK_REPO_ROOT ?? process.env.NAVIA_REPO_ROOT ?? findRepoRoot(process.cwd()),
  "packages/spark-db/src/migrations",
);

export function loadMigrations(): Migration[] {
  const migrationsDir = existsSync(sourceMigrationsDir) ? sourceMigrationsDir : repoMigrationsDir;

  if (!existsSync(migrationsDir)) {
    throw new Error(`Spark migrations directory not found: ${migrationsDir}`);
  }

  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const [versionPart, ...nameParts] = file.replace(/\.sql$/, "").split("_");
      if (!versionPart || nameParts.length === 0) {
        throw new Error(`Invalid migration filename: ${file}`);
      }

      return {
        version: versionPart,
        name: nameParts.join("_"),
        sql: readFileSync(join(migrationsDir, file), "utf8"),
      };
    });
}

function findRepoRoot(start: string): string {
  let current = resolve(start);

  while (true) {
    if (
      existsSync(join(current, "pnpm-workspace.yaml")) &&
      existsSync(join(current, "packages/spark-db/src/migrations"))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return start;
    }

    current = parent;
  }
}

export function migrate(db: DatabaseSync, migrations = loadMigrations()): void {
  db.exec("BEGIN");
  try {
    const bootstrapMigration = migrations.find((migration) => migration.version === "0001");
    if (!bootstrapMigration) {
      throw new Error("Missing bootstrap migration 0001");
    }

    const schemaMigrationsExists = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1",
        )
        .get(),
    );
    if (!schemaMigrationsExists) {
      db.exec(bootstrapMigration.sql);
    }

    const bootstrapAppliedAt = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(bootstrapMigration.version, bootstrapMigration.name, bootstrapAppliedAt);

    const hasMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1");
    const insertMigration = db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (migration.version === bootstrapMigration.version || hasMigration.get(migration.version)) {
        continue;
      }

      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
