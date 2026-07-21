import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { runDirectGraft } from "../packages/spark-graft/src/graft-client.ts";

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${body}`, "utf8");
  await chmod(path, 0o755);
}

test("runDirectGraft times out hung graft CLI processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-graft-timeout-"));
  const previousGraftBin = process.env.GRAFT_BIN;
  try {
    const graftBin = join(root, "graft-hang.js");
    await writeExecutable(graftBin, "setInterval(() => undefined, 1000);\n");
    process.env.GRAFT_BIN = graftBin;

    await assert.rejects(
      runDirectGraft(root, ["status"], { timeoutMs: 10 }),
      /graft CLI timed out after 10ms/u,
    );
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    await rm(root, { recursive: true, force: true });
  }
});

test("runDirectGraft abort signal cancels a hung graft CLI process", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-graft-abort-"));
  const previousGraftBin = process.env.GRAFT_BIN;
  try {
    const graftBin = join(root, "graft-hang.js");
    await writeExecutable(graftBin, "setInterval(() => undefined, 1000);\n");
    process.env.GRAFT_BIN = graftBin;
    const controller = new AbortController();
    const run = runDirectGraft(root, ["status"], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort("test abort");

    await assert.rejects(run, /graft CLI aborted: test abort/u);
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    await rm(root, { recursive: true, force: true });
  }
});

test("runDirectGraft successful calls still complete before timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-graft-success-"));
  const previousGraftBin = process.env.GRAFT_BIN;
  try {
    const graftBin = join(root, "graft-ok.js");
    await writeExecutable(graftBin, "process.stdout.write('ok\\n');\n");
    process.env.GRAFT_BIN = graftBin;

    const result = await runDirectGraft(root, ["status"], { timeoutMs: 10_000 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.deepEqual(result.argv, ["--cwd", root, "status"]);
  } finally {
    if (previousGraftBin === undefined) delete process.env.GRAFT_BIN;
    else process.env.GRAFT_BIN = previousGraftBin;
    await rm(root, { recursive: true, force: true });
  }
});
