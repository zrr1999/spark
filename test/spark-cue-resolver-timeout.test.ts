import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCueTransport } from "../packages/spark-cue/src/cue-client.ts";

void test("resolveCueTransport times out hung resolver commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-cue-resolver-timeout-"));
  const previousPath = process.env.PATH;
  const previousTimeout = process.env.PI_CUE_RESOLVER_TIMEOUT_MS;
  try {
    const cueClient = join(root, "cue-client");
    await writeFile(
      cueClient,
      `#!${process.execPath}\nsetInterval(() => undefined, 1000);\n`,
      "utf8",
    );
    await chmod(cueClient, 0o755);
    process.env.PATH = root;
    process.env.PI_CUE_RESOLVER_TIMEOUT_MS = "10";

    await assert.rejects(resolveCueTransport(), /resolver timed out after 10ms/u);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTimeout === undefined) delete process.env.PI_CUE_RESOLVER_TIMEOUT_MS;
    else process.env.PI_CUE_RESOLVER_TIMEOUT_MS = previousTimeout;
    await rm(root, { recursive: true, force: true });
  }
});
