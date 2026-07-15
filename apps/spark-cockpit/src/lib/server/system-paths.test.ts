import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultArtifactCacheRoot } from "./artifact-cache.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Cockpit system paths", () => {
  it("uses the unified default Spark root for artifact previews", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example", ".spark", "apps", "cockpit", "cache", "artifacts"),
    );
  });

  it("relocates artifact previews with SPARK_HOME", () => {
    process.env = { HOME: "/Users/example", SPARK_HOME: "/Users/example/spark-home" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example/spark-home", "apps", "cockpit", "cache", "artifacts"),
    );
  });
});
