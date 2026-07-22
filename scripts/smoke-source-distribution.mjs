#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkSourceDistribution } from "./check-source-distribution.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
    });
  } catch (error) {
    const details = [
      `${command} ${args.join(" ")} failed`,
      error?.stdout?.trim(),
      error?.stderr?.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(details, { cause: error });
  }
}

async function smokeBuiltDaemon(runtimeDirectory) {
  const dispatcher = resolve(root, "apps/spark-cli/bin/spark");
  await stat(resolve(root, "apps/spark-daemon/dist/migrations/0001_initial.sql"));
  const environment = {
    ...process.env,
    SPARK_HOME: join(runtimeDirectory, "daemon"),
    SPARK_REPO_ROOT: join(runtimeDirectory, "missing-repository-root"),
  };
  let startAttempted = false;
  let started = false;
  try {
    startAttempted = true;
    const start = await run(dispatcher, ["daemon", "start", "--json"], {
      env: environment,
    });
    started = true;
    const startResult = JSON.parse(start.stdout);
    const instanceId = startResult.daemon?.lifecycle?.process?.instanceId;
    if (startResult.daemon?.running !== true || typeof instanceId !== "string") {
      throw new Error("Built daemon did not report a running process identity");
    }
    const status = await run(dispatcher, ["daemon", "status", "--json"], {
      env: environment,
    });
    const statusResult = JSON.parse(status.stdout);
    if (
      statusResult.daemon?.running !== true ||
      statusResult.daemon?.lifecycle?.process?.instanceId !== instanceId
    ) {
      throw new Error("Source dispatcher did not reach the built daemon identity");
    }
    await stat(join(environment.SPARK_HOME, "apps/daemon/data/daemon.sqlite"));
  } finally {
    if (startAttempted) {
      try {
        await run(dispatcher, ["daemon", "stop", "--yes"], { env: environment });
      } catch (error) {
        if (started) throw error;
      }
    }
  }
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port === undefined) reject(new Error("Could not allocate a Cockpit smoke port"));
        else resolvePort(port);
      });
    });
  });
}

async function waitForCockpit(url, processState, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (processState.exit !== undefined) {
      throw new Error(`Cockpit exited before accepting HTTP requests (${processState.exit})`);
    }
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.status === 200 && body?.service === "spark-cockpit" && body?.status === "ok") {
        return;
      }
      lastError = new Error(`Cockpit health marker was invalid (HTTP ${response.status})`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Cockpit did not become ready: ${String(lastError)}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
}

async function smokeCockpit(runtimeDirectory) {
  const port = await availablePort();
  const state = { exit: undefined, stderr: "" };
  const child = spawn(process.execPath, [resolve(root, "apps/spark-cockpit/build")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      ORIGIN: `http://127.0.0.1:${port}`,
      PORT: String(port),
      SPARK_HOME: join(runtimeDirectory, "cockpit"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  child.once("exit", (code, signal) => {
    state.exit = code ?? signal ?? "unknown";
  });
  try {
    await waitForCockpit(`http://127.0.0.1:${port}/api/v1/health`, state);
  } catch (error) {
    throw new Error(`${String(error)}\n${state.stderr.trim()}`.trim(), { cause: error });
  } finally {
    child.kill("SIGTERM");
    const stopped = await waitForChildExit(child, 2_000);
    if (!stopped) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 2_000);
    }
  }
}

const temporaryRoot = await mkdtemp("/tmp/spk-src-");
try {
  const { workspaces } = await checkSourceDistribution(root);
  await run("pnpm", ["run", "build"], { timeout: 300_000 });
  await checkSourceDistribution(root, { requireBuiltBins: true });
  await run(resolve(root, "apps/spark-cli/bin/spark"), ["--help"]);
  await run(resolve(root, "apps/spark-tui/bin/spark-tui"), ["--help"]);
  await smokeBuiltDaemon(temporaryRoot);
  await smokeCockpit(temporaryRoot);
  console.log(
    `Source distribution smoke passed for ${workspaces.length} private workspaces, built daemon, dispatcher, TUI, and Cockpit.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
