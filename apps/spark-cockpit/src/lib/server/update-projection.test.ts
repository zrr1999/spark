import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveSparkUpdatePaths, writeSparkUpdateState } from "@zendev-lab/spark-update";
import { readCockpitUpdateProjection } from "./update-projection.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Cockpit reads a bounded updater projection without installation paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-cockpit-update-"));
  roots.push(root);
  const env = { SPARK_HOME: root, HOME: root };
  await writeSparkUpdateState(resolveSparkUpdatePaths({ env }), {
    schemaVersion: 1,
    currentVersion: "0.1.0",
    availableVersion: "0.1.1",
    pendingVersion: "0.1.1",
    quarantined: [
      {
        version: "0.1.2",
        reason: "candidate health failed",
        quarantinedAt: "2026-07-24T00:00:00.000Z",
      },
    ],
  });

  await expect(readCockpitUpdateProjection({ env })).resolves.toMatchObject({
    managed: false,
    policy: "notify",
    channel: "latest",
    current: "0.1.0",
    available: "0.1.1",
    pending: "0.1.1",
    quarantined: [{ version: "0.1.2" }],
  });
});
