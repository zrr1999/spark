#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

async function runWithCleanup(operation, cleanup, message) {
  let result;
  let operationFailure;
  try {
    result = await operation();
  } catch (error) {
    operationFailure = asError(error);
  }

  let cleanupFailure;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = asError(error);
  }

  if (operationFailure && cleanupFailure) {
    throw new AggregateError([operationFailure, cleanupFailure], message);
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
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
  await runWithCleanup(
    async () => {
      startAttempted = true;
      const start = await run(dispatcher, ["daemon", "start", "--json"], {
        env: environment,
      });
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
    },
    async () => {
      if (!startAttempted) return;
      await run(dispatcher, ["daemon", "stop", "--yes"], { env: environment });
    },
    "Built daemon smoke failed and its process could not be stopped",
  );
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
  await runWithCleanup(
    async () => {
      try {
        await waitForCockpit(`http://127.0.0.1:${port}/api/v1/health`, state);
      } catch (error) {
        throw new Error(`${String(error)}\n${state.stderr.trim()}`.trim(), { cause: error });
      }
    },
    async () => {
      child.kill("SIGTERM");
      const stopped = await waitForChildExit(child, 2_000);
      if (stopped) return;
      child.kill("SIGKILL");
      const killed = await waitForChildExit(child, 2_000);
      if (!killed) throw new Error(`Cockpit process ${child.pid ?? "unknown"} did not stop`);
    },
    "Cockpit smoke failed and its process could not be stopped",
  );
}

async function createPrivateTemporaryRoot() {
  // Spark daemon IPC uses a Unix socket. Darwin's short sun_path limit rules out its usual
  // /var/folders TMPDIR, so use the sticky /tmp parent there and secure the new random child.
  const parent = process.platform === "darwin" ? "/tmp" : tmpdir();
  const directory = await mkdtemp(join(parent, "spk-src-")); // NOSONAR -- atomically created, owner-checked, and forced to 0700 below.
  try {
    await chmod(directory, 0o700);
    const details = await lstat(directory);
    const expectedOwner = process.getuid?.();
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`Temporary runtime root is not a real directory: ${directory}`);
    }
    if (expectedOwner !== undefined && details.uid !== expectedOwner) {
      throw new Error(`Temporary runtime root is not owned by the current user: ${directory}`);
    }
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new Error(`Temporary runtime root permissions are not private: ${directory}`);
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function smokeSourceDistribution() {
  const temporaryRoot = await createPrivateTemporaryRoot();
  await runWithCleanup(
    async () => {
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
    },
    () => rm(temporaryRoot, { recursive: true, force: true }),
    "Source distribution smoke failed and its private runtime root could not be removed",
  );
}

await smokeSourceDistribution();
