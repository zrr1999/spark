import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureNaviaPathDirs, resolveNaviaPaths } from "@zendev-lab/navia-system";
import { legacySparkDaemonStatePaths, migrateLegacySparkDaemonState } from "./migration.js";

describe("migrateLegacySparkDaemonState", () => {
  it("imports old daemon config/database/artifact state into Spark daemon paths once", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-migration-"));
    try {
      const env = {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
      };
      const paths = resolveNaviaPaths({ app: "daemon", env, cwd: "/" });
      const legacy = legacySparkDaemonStatePaths(env, "/");
      mkdirSync(join(legacy.configFile, ".."), { recursive: true });
      mkdirSync(legacy.dataDir, { recursive: true });
      mkdirSync(legacy.artifactBlobsDir, { recursive: true });
      mkdirSync(legacy.runtimeDir, { recursive: true });
      writeFileSync(
        legacy.configFile,
        'installationId = "navia-runner-existing"\ndisplayName = "Navia runner"\nruntimeToken = "tok"\n',
      );
      writeFileSync(legacy.databasePath, "legacy db");
      writeFileSync(join(legacy.artifactBlobsDir, "abc"), "blob");
      writeFileSync(legacy.socketPath, "stale socket");
      writeFileSync(legacy.pidFile, "999999999\n");
      writeFileSync(legacy.lockPath, "{}\n");

      ensureNaviaPathDirs(paths);
      const result = migrateLegacySparkDaemonState(paths, {
        env,
        cwd: "/",
        now: new Date("2026-06-20T00:00:00.000Z"),
      });

      expect(result.copied).toEqual(
        expect.arrayContaining([
          expect.stringContaining("config:"),
          expect.stringContaining("database:"),
          expect.stringContaining("artifact blobs:"),
        ]),
      );
      expect(readFileSync(paths.configFile, "utf8")).toContain(
        'installationId = "spark-daemon-existing"',
      );
      expect(readFileSync(paths.configFile, "utf8")).toContain('displayName = "Spark daemon"');
      expect(readFileSync(paths.databasePath, "utf8")).toBe("legacy db");
      expect(readFileSync(join(paths.artifactBlobsDir, "abc"), "utf8")).toBe("blob");
      expect(existsSync(legacy.socketPath)).toBe(false);
      expect(existsSync(legacy.pidFile)).toBe(false);
      expect(existsSync(legacy.lockPath)).toBe(false);
      expect(existsSync(result.markerFile)).toBe(true);

      const second = migrateLegacySparkDaemonState(paths, { env, cwd: "/" });
      expect(second.copied).not.toEqual(
        expect.arrayContaining([expect.stringContaining("config:")]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
