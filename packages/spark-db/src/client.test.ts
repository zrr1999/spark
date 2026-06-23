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

  it("keeps NAVIA_DATA_DIR as a legacy Cockpit data override", () => {
    process.env = { HOME: "/Users/example", NAVIA_DATA_DIR: "/Users/example/legacy-navia" };

    expect(defaultDatabasePath()).toBe(join("/Users/example/legacy-navia", "cockpit.sqlite"));
  });
});
