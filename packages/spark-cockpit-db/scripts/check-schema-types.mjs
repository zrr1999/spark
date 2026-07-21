#!/usr/bin/env node
/**
 * Validate handwritten Kysely table types against a migrated SQLite schema.
 *
 * kysely-codegen was evaluated against a migrated temp DB (via better-sqlite3) but
 * produced poorer types than the handwritten `src/types.ts` (PRIMARY KEY columns
 * became `string | null`, enum unions collapsed to `string`). Keep handwritten
 * types as the source of truth and gate on PRAGMA table_info / table inventory.
 *
 * Usage: node --experimental-strip-types scripts/check-schema-types.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "../src/migrate.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const typesPath = join(packageRoot, "src", "types.ts");

const db = new DatabaseSync(":memory:");
migrate(db);

const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((row) => String(row.name));

const schema = new Map();
for (const table of tables) {
  const columns = db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((row) => String(row.name))
    .sort();
  schema.set(table, columns);
}
db.close();

const typesSource = readFileSync(typesPath, "utf8");
const sparkDatabaseMatch = typesSource.match(/export interface SparkDatabase \{([\s\S]*?)\n\}/u);
if (!sparkDatabaseMatch) {
  throw new Error("SparkDatabase interface not found in src/types.ts");
}

const declaredTables = [
  ...sparkDatabaseMatch[1].matchAll(/^\s*([a-z0-9_]+):\s*([A-Za-z0-9_]+);/gmu),
].map((match) => ({ table: match[1], typeName: match[2] }));

const declaredTableNames = new Set(declaredTables.map((entry) => entry.table));
const schemaTableNames = new Set(tables);

const missingFromTypes = [...schemaTableNames].filter((name) => !declaredTableNames.has(name));
const extraInTypes = [...declaredTableNames].filter((name) => !schemaTableNames.has(name));

const columnMismatches = [];
for (const { table, typeName } of declaredTables) {
  if (!schema.has(table)) continue;
  const interfaceMatch = typesSource.match(
    new RegExp(`export interface ${typeName} \\{([\\s\\S]*?)\\n\\}`, "u"),
  );
  if (!interfaceMatch) {
    columnMismatches.push(`${table}: missing interface ${typeName}`);
    continue;
  }
  const typedColumns = [...interfaceMatch[1].matchAll(/^\s*([a-z0-9_]+)\s*[?]?\s*:/gmu)].map(
    (match) => match[1],
  );
  const schemaColumns = schema.get(table) ?? [];
  const typedSet = new Set(typedColumns);
  const schemaSet = new Set(schemaColumns);
  const missingColumns = schemaColumns.filter((column) => !typedSet.has(column));
  const extraColumns = typedColumns.filter((column) => !schemaSet.has(column));
  if (missingColumns.length > 0 || extraColumns.length > 0) {
    columnMismatches.push(
      `${table} (${typeName}): missing=[${missingColumns.join(", ")}] extra=[${extraColumns.join(", ")}]`,
    );
  }
}

if (missingFromTypes.length > 0) {
  console.warn(
    `spark-db note: ${missingFromTypes.length} schema table(s) not in SparkDatabase (allowed until Kysely coverage expands):`,
  );
  for (const name of missingFromTypes) console.warn(`- ${name}`);
}

if (extraInTypes.length > 0 || columnMismatches.length > 0) {
  console.error("spark-db schema/type drift detected:");
  for (const name of extraInTypes) console.error(`- table in types.ts but not in schema: ${name}`);
  for (const mismatch of columnMismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log(
  `spark-db schema types OK (${tables.length} tables, ${declaredTables.length} SparkDatabase entries)`,
);

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}
