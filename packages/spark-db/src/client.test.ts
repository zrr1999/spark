import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDatabasePath } from "./client.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("defaultDatabasePath", () => {
  it("uses the unified default Spark root", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultDatabasePath()).toBe(
      join("/Users/example", ".spark", "apps", "cockpit", "data", "cockpit.sqlite"),
    );
  });

  it("relocates Cockpit data with SPARK_HOME", () => {
    process.env = { HOME: "/Users/example", SPARK_HOME: "/Users/example/spark-home" };

    expect(defaultDatabasePath()).toBe(
      join("/Users/example/spark-home", "apps", "cockpit", "data", "cockpit.sqlite"),
    );
  });
});
