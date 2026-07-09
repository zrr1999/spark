import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultArtifactCacheRoot } from "./artifact-cache.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Cockpit system paths", () => {
  it("uses the Spark Cockpit XDG cache path for artifact previews", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example", ".cache", "spark", "cockpit", "artifacts"),
    );
  });

  it("honors SPARK_COCKPIT_CACHE_DIR for artifact previews", () => {
    process.env = { HOME: "/Users/example", SPARK_COCKPIT_CACHE_DIR: "/Users/example/spark-cache" };

    expect(defaultArtifactCacheRoot()).toBe(join("/Users/example/spark-cache", "artifacts"));
  });
});
