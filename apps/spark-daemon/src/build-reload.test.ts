import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSparkDaemonBuildChangeProbe,
  sparkDaemonDeploymentEntrypointPath,
  sparkDaemonEntrypointFingerprint,
} from "./build-reload.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Spark daemon build reload", () => {
  it("fingerprints the deployed entrypoint content", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-build-"));
    tempRoots.push(root);
    const entrypoint = join(root, "cli.js");
    writeFileSync(entrypoint, "first");
    const first = sparkDaemonEntrypointFingerprint(entrypoint);
    writeFileSync(entrypoint, "second");
    expect(sparkDaemonEntrypointFingerprint(entrypoint)).not.toBe(first);
  });

  it("keeps the deployment path so an atomic symlink switch remains observable", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-build-link-"));
    tempRoots.push(root);
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    writeFileSync(join(firstRoot, "cli.js"), "first");
    writeFileSync(join(secondRoot, "cli.js"), "second");
    const deployed = join(root, "current");
    const replacement = join(root, "replacement");
    symlinkSync(firstRoot, deployed);
    symlinkSync(secondRoot, replacement);
    const entrypoint = sparkDaemonDeploymentEntrypointPath(["node", join(deployed, "cli.js")]);
    const first = sparkDaemonEntrypointFingerprint(entrypoint);

    rmSync(deployed);
    renameSync(replacement, deployed);

    expect(entrypoint).toBe(join(deployed, "cli.js"));
    expect(sparkDaemonEntrypointFingerprint(entrypoint)).not.toBe(first);
  });

  it("uses managed build-info as the deployment watch target and canonical fingerprint", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-build-info-"));
    tempRoots.push(root);
    const buildInfo = join(root, "build-info.json");
    const fingerprint = `sha256:${"a".repeat(64)}`;
    writeFileSync(buildInfo, JSON.stringify({ fingerprint }));

    expect(
      sparkDaemonDeploymentEntrypointPath(["node", join(root, "old-cli.js")], import.meta.url, {
        SPARK_DEPLOYMENT_WATCH_PATH: buildInfo,
      }),
    ).toBe(buildInfo);
    expect(sparkDaemonEntrypointFingerprint(buildInfo)).toBe(fingerprint);
  });

  it("requires a stable replacement before requesting a restart", () => {
    const probe = createSparkDaemonBuildChangeProbe("old", 2_000);

    expect(probe.observe("partial", 1_000)).toBeUndefined();
    expect(probe.observe("new", 1_500)).toBeUndefined();
    expect(probe.observe("new", 3_499)).toBeUndefined();
    expect(probe.observe("new", 3_500)).toEqual({
      previousFingerprint: "old",
      nextFingerprint: "new",
    });
  });

  it("cancels a pending replacement when the original build returns", () => {
    const probe = createSparkDaemonBuildChangeProbe("old", 1_000);

    expect(probe.observe("partial", 1_000)).toBeUndefined();
    expect(probe.observe("old", 1_500)).toBeUndefined();
    expect(probe.observe("partial", 1_600)).toBeUndefined();
    expect(probe.observe("partial", 2_500)).toBeUndefined();
    expect(probe.observe("partial", 2_600)).toEqual({
      previousFingerprint: "old",
      nextFingerprint: "partial",
    });
  });
});
