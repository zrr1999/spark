import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { exerciseSparkDaemonLifecycle } from "../support/spark-process-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("source-distributed spark bin starts, reports, and stops the daemon", async () => {
  const temporary = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-source-process-"),
  );
  await chmod(temporary, 0o700);
  try {
    await exerciseSparkDaemonLifecycle({
      command: resolve(root, "apps/spark-cli/bin/spark"),
      cwd: root,
      env: {
        ...process.env,
        SPARK_HOME: resolve(temporary, "spark-home"),
        SPARK_REPO_ROOT: root,
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
