import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

const repoRoot = new URL("..", import.meta.url);

test("Spark extension adapters do not own autonomous driver timers or turn state", async () => {
  const commandRegistration = await source(
    "packages/spark-extension/src/extension/spark-command-registration.ts",
  );
  const workflowManager = await source(
    "packages/spark-extension/src/extension/spark-workflow-run-manager.ts",
  );

  for (const [path, text] of [
    ["spark-command-registration.ts", commandRegistration],
    ["spark-workflow-run-manager.ts", workflowManager],
  ] as const) {
    assert.doesNotMatch(text, /\bsetTimeout\s*\(/u, `${path} must not own a driver timer`);
    assert.doesNotMatch(
      text,
      /SparkForegroundDriveSubstrate|awaitingTurn|foregroundGeneration/u,
      `${path} must not retain frontend driver state`,
    );
  }
  assert.doesNotMatch(
    commandRegistration,
    /["']agent_end["']|["']turn_end["']|["']tool_execution_end["']/u,
    "driver continuation must not be attached to Pi lifecycle events",
  );

  await assert.rejects(
    access(new URL("packages/spark-extension/src/extension/spark-drive-substrate.ts", repoRoot)),
  );
});

test("daemon runtime never imports the frozen Pi product facade", async () => {
  const daemonFiles = await typescriptFiles(new URL("apps/spark-daemon/src/", repoRoot));
  for (const path of daemonFiles) {
    const text = await readFile(path, "utf8");
    assert.doesNotMatch(
      text,
      /(?:from|import)\s*\(?\s*["'][^"']*(?:pi-extension|pi-coding-agent)[^"']*["']/u,
      `${path} imports a frozen Pi product package`,
    );
  }
});

test("workspace domain state no longer exports frontend cadence or retry ownership", async () => {
  const loopState = await source("packages/spark-loop/src/session-loops.ts");
  const goalState = await source("packages/spark-loop/src/session-goals.ts");
  const reproState = await source("packages/spark-repro/src/index.ts");
  const extensionLoopState = await source(
    "packages/spark-extension/src/extension/spark-session-loops.ts",
  );

  assert.doesNotMatch(
    `${loopState}\n${extensionLoopState}`,
    /export (?:async function scheduleSessionLoopTick|interface SparkSessionLoop(?:Retry|Schedule)State)/u,
  );
  assert.doesNotMatch(goalState, /export interface SparkSessionGoalRetryState/u);
  assert.doesNotMatch(reproState, /export interface SparkSessionReproRetryState/u);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, repoRoot), "utf8");
}

async function typescriptFiles(directory: URL): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory.pathname, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await typescriptFiles(new URL(`${entry.name}/`, directory))));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(path);
    }
  }
  return paths;
}
