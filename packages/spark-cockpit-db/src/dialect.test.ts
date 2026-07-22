import { afterEach, describe, expect, it } from "vitest";
import { CompiledQuery, Kysely, type Generated } from "kysely";
import { NodeSqliteDialect, openMemoryDatabase } from "./index.js";

interface TestDatabase {
  items: {
    id: Generated<number>;
    label: string;
  };
}

describe("NodeSqliteDialect", () => {
  const databases: Array<Kysely<TestDatabase>> = [];

  afterEach(async () => {
    await Promise.all(databases.map((db) => db.destroy()));
    databases.length = 0;
  });

  function createDb(): Kysely<TestDatabase> {
    const db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteDialect({ database: openMemoryDatabase() }),
    });
    databases.push(db);
    return db;
  }

  it("executes basic Kysely queries through node:sqlite", async () => {
    const db = createDb();

    await db.schema
      .createTable("items")
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("label", "text", (column) => column.notNull())
      .execute();

    await db.insertInto("items").values({ label: "first" }).execute();

    const rows = await db.selectFrom("items").selectAll().execute();
    expect(rows).toEqual([{ id: 1, label: "first" }]);
  });

  it("supports factory databases, connection hooks, and transactions", async () => {
    let created = 0;
    const db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteDialect({
        database: () => {
          created += 1;
          return openMemoryDatabase();
        },
        onCreateConnection: async (connection) => {
          await connection.executeQuery(
            CompiledQuery.raw(
              "create table items (id integer primary key autoincrement, label text not null)",
            ),
          );
        },
      }),
    });
    databases.push(db);

    await db.insertInto("items").values({ label: "hooked" }).execute();
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("items").values({ label: "txn" }).execute();
        return trx.selectFrom("items").selectAll().execute();
      }),
    ).resolves.toEqual([
      { id: 1, label: "hooked" },
      { id: 2, label: "txn" },
    ]);
    expect(created).toBe(1);
  });

  it("coerces boolean and Date bind parameters", async () => {
    const db = createDb();
    await db.schema
      .createTable("items")
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("label", "text", (column) => column.notNull())
      .execute();

    await db
      .insertInto("items")
      .values({ label: true as unknown as string })
      .execute();
    await db
      .insertInto("items")
      .values({ label: new Date("2026-01-02T03:04:05.000Z") as unknown as string })
      .execute();

    const rows = await db.selectFrom("items").selectAll().orderBy("id").execute();
    expect(rows).toEqual([
      { id: 1, label: "1.0" },
      { id: 2, label: "2026-01-02T03:04:05.000Z" },
    ]);
  });

  it("rejects unsupported bind parameters", async () => {
    const db = createDb();
    await db.schema
      .createTable("items")
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("label", "text", (column) => column.notNull())
      .execute();

    await expect(
      db
        .insertInto("items")
        .values({ label: { nested: true } as unknown as string })
        .execute(),
    ).rejects.toThrow(/Unsupported SQLite parameter type/u);
  });

  it("exposes adapter and introspector factories", () => {
    const dialect = new NodeSqliteDialect({ database: openMemoryDatabase() });
    expect(dialect.createAdapter()).toBeTruthy();
    const db = createDb();
    expect(dialect.createIntrospector(db as never)).toBeTruthy();
  });

  it("streams select rows through the dialect connection", async () => {
    const db = createDb();
    await db.schema
      .createTable("items")
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("label", "text", (column) => column.notNull())
      .execute();
    await db.insertInto("items").values({ label: "a" }).execute();
    await db.insertInto("items").values({ label: "b" }).execute();

    const streamed: Array<{ id: number; label: string }> = [];
    for await (const row of db.selectFrom("items").selectAll().stream()) {
      streamed.push(row);
    }
    expect(streamed).toEqual([
      { id: 1, label: "a" },
      { id: 2, label: "b" },
    ]);
  });
});
