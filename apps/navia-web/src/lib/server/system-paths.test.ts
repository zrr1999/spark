import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultArtifactCacheRoot } from "./artifact-cache.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("server system paths", () => {
  it("uses the server XDG cache path for artifact previews", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example", ".cache", "navia", "server", "artifacts"),
    );
  });

  it("honors NAVIA_SERVER_CACHE_DIR for artifact previews", () => {
    process.env = { HOME: "/Users/example", NAVIA_SERVER_CACHE_DIR: "/tmp/navia-cache" };

    expect(defaultArtifactCacheRoot()).toBe(join("/tmp/navia-cache", "artifacts"));
  });
});
