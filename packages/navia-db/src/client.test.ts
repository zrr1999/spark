import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDatabasePath } from "./client.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("defaultDatabasePath", () => {
  it("uses the server XDG data path by default", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultDatabasePath()).toBe(
      join("/Users/example", ".local", "share", "navia", "server", "navia.sqlite"),
    );
  });

  it("keeps NAVIA_DATA_DIR as a deprecated server data override", () => {
    process.env = { HOME: "/Users/example", NAVIA_DATA_DIR: "/tmp/legacy-navia" };

    expect(defaultDatabasePath()).toBe(join("/tmp/legacy-navia", "navia.sqlite"));
  });
});
