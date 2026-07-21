import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPragmas, defaultDatabasePath, openDatabase, openMemoryDatabase } from "./client.js";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("defaultDatabasePath", () => {
  it("uses the default XDG data root", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultDatabasePath()).toBe(
      join("/Users/example", ".local", "share", "spark", "cockpit", "cockpit.sqlite"),
    );
  });

  it("relocates Cockpit data with SPARK_HOME", () => {
    process.env = { HOME: "/Users/example", SPARK_HOME: "/Users/example/spark-home" };

    expect(defaultDatabasePath()).toBe(
      join("/Users/example/spark-home", "apps", "cockpit", "data", "cockpit.sqlite"),
    );
  });
});

describe("openMemoryDatabase", () => {
  it("applies foreign-key and busy-timeout pragmas", () => {
    const db = openMemoryDatabase();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    applyPragmas(db);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("opens a file-backed database under an explicit path", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-db-client-"));
    tempRoots.push(root);
    const path = join(root, "nested", "test.sqlite");
    const db = openDatabase({ path });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
  });
});
