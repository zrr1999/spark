import { migrate, openDatabase } from "@navia-dev/db";

let database: ReturnType<typeof openDatabase> | undefined;

export function getDatabase() {
  database ??= openDatabase();
  migrate(database);
  return database;
}
