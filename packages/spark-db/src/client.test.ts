import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDatabasePath } from "./client.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("defaultDatabasePath", () => {
  it("uses the Spark Cockpit XDG data path by default", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultDatabasePath()).toBe(
      join("/Users/example", ".local", "share", "spark", "cockpit", "cockpit.sqlite"),
    );
  });

  it("uses SPARK_COCKPIT_DATA_DIR as the Cockpit data override", () => {
    process.env = {
      HOME: "/Users/example",
      SPARK_COCKPIT_DATA_DIR: "/Users/example/spark-cockpit",
    };

    expect(defaultDatabasePath()).toBe(join("/Users/example/spark-cockpit", "cockpit.sqlite"));
  });
});
