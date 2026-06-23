import { afterEach, describe, expect, it } from "vitest";
import { Kysely, type Generated } from "kysely";
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
});
