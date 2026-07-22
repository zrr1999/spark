import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { resolveCueTransport } from "./cue-client.ts";

test("resolveCueTransport times out hung resolver commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-cue-resolver-timeout-"));
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousCargoHome = process.env.CARGO_HOME;
  const previousUvToolBinDir = process.env.UV_TOOL_BIN_DIR;
  const previousTimeout = process.env.PI_CUE_RESOLVER_TIMEOUT_MS;
  try {
    const hangingResolver = `#!${process.execPath}\nsetInterval(() => undefined, 1000);\n`;
    await Promise.all(
      ["cue-client", "cue"].map(async (command) => {
        const executable = join(root, command);
        await writeFile(executable, hangingResolver, "utf8");
        await chmod(executable, 0o755);
      }),
    );
    process.env.PATH = root;
    process.env.HOME = root;
    process.env.CARGO_HOME = join(root, "cargo");
    process.env.UV_TOOL_BIN_DIR = root;
    process.env.PI_CUE_RESOLVER_TIMEOUT_MS = "10";

    await assert.rejects(resolveCueTransport(), /resolver timed out after 10ms/u);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCargoHome === undefined) delete process.env.CARGO_HOME;
    else process.env.CARGO_HOME = previousCargoHome;
    if (previousUvToolBinDir === undefined) delete process.env.UV_TOOL_BIN_DIR;
    else process.env.UV_TOOL_BIN_DIR = previousUvToolBinDir;
    if (previousTimeout === undefined) delete process.env.PI_CUE_RESOLVER_TIMEOUT_MS;
    else process.env.PI_CUE_RESOLVER_TIMEOUT_MS = previousTimeout;
    await rm(root, { recursive: true, force: true });
  }
});
