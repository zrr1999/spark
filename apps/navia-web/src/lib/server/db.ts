import { migrate, openDatabase } from "@zendev-lab/navia-db";

let database: ReturnType<typeof openDatabase> | undefined;

export function getDatabase() {
  database ??= openDatabase();
  migrate(database);
  return database;
}
