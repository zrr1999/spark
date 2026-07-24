#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tarballArgumentIndex = process.argv.indexOf("--tarball");
const suppliedTarball =
  tarballArgumentIndex >= 0 ? process.argv[tarballArgumentIndex + 1] : undefined;
if (tarballArgumentIndex >= 0 && !suppliedTarball) {
  throw new Error("--tarball requires a path");
}

function cleanPath() {
  const repoPrefix = `${root.replaceAll("\\", "/")}/`;
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter((entry) => {
    const portable = entry.replaceAll("\\", "/");
    const normalized = portable.endsWith("/") ? portable : `${portable}/`;
    return !normalized.startsWith(repoPrefix) && !normalized.includes("/node_modules/.bin/");
  });
  return [
    ...new Set([
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      ...pathEntries,
    ]),
  ].join(delimiter);
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`, {
      cause: error,
    });
  }
}

async function temporaryRoot() {
  const directory = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spk-npm-"),
  );
  await chmod(directory, 0o700);
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("unsafe temporary root");
  return directory;
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Cockpit exited with ${child.exitCode}${output.stderr ? `\n${output.stderr.trim()}` : ""}`,
      );
    }
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok && body?.service === "spark-cockpit" && body?.status === "ok") return;
      lastError = new Error(`unexpected cockpit health response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Cockpit did not become healthy: ${String(lastError)}`);
}

function terminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
  child.kill("SIGTERM");
}

const temporary = await temporaryRoot();
try {
  let tarballPath;
  if (suppliedTarball) {
    tarballPath = resolve(root, suppliedTarball);
    console.log(`Using prebuilt npm product artifact ${tarballPath}...`);
  } else {
    console.log("Building npm product artifact...");
    await run("node", ["scripts/build-npm-product.mjs"], {
      cwd: root,
      env: process.env,
      timeout: 300_000,
    });
    console.log("Packing generated npm artifact...");
    await run("pnpm", ["pack", "--pack-destination", temporary], {
      cwd: resolve(root, "dist/npm-package"),
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    const tarballs = (await readdir(temporary)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one packed tarball, found ${tarballs.join(", ")}`);
    }
    tarballPath = resolve(temporary, tarballs[0]);
  }
  const tarball = tarballPath.split(/[\\/]/u).at(-1);
  const packed = await stat(tarballPath);
  const installRoot = resolve(temporary, "install");
  await mkdir(installRoot, { recursive: true });
  console.log("Installing tarball into an isolated directory...");
  await run("npm", ["init", "--yes"], {
    cwd: installRoot,
    env: { ...process.env, PATH: cleanPath() },
  });
  await run("npm", ["install", "--ignore-scripts", tarballPath], {
    cwd: installRoot,
    env: { ...process.env, PATH: cleanPath() },
    timeout: 300_000,
  });
  const spark =
    process.platform === "win32"
      ? process.execPath
      : resolve(installRoot, "node_modules/.bin/spark");
  const sparkArgvPrefix =
    process.platform === "win32"
      ? [resolve(installRoot, "node_modules/@zendev-lab/spark/bin/spark")]
      : [];
  const environment = {
    ...process.env,
    PATH: cleanPath(),
    SPARK_HOME: resolve(temporary, "spark-home"),
    SPARK_REPO_ROOT: resolve(temporary, "not-the-repository"),
  };
  console.log("Probing installed dispatcher, TUI, and daemon...");
  await run(spark, [...sparkArgvPrefix, "--help"], { cwd: installRoot, env: environment });
  const version = await run(spark, [...sparkArgvPrefix, "version", "--json"], {
    cwd: installRoot,
    env: environment,
  });
  const buildInfo = JSON.parse(version.stdout);
  if (buildInfo.packageName !== "@zendev-lab/spark" || !buildInfo.fingerprint) {
    throw new Error("installed product did not expose valid build-info");
  }
  const updateStatus = await run(spark, [...sparkArgvPrefix, "update", "status", "--json"], {
    cwd: installRoot,
    env: environment,
  });
  if (JSON.parse(updateStatus.stdout).config?.policy !== "notify") {
    throw new Error("installed product did not expose the default managed-update projection");
  }
  await run(spark, [...sparkArgvPrefix, "tui", "--help"], { cwd: installRoot, env: environment });
  const started = await run(spark, [...sparkArgvPrefix, "daemon", "start", "--json"], {
    cwd: installRoot,
    env: environment,
  });
  if (JSON.parse(started.stdout).daemon?.running !== true)
    throw new Error("installed daemon did not start");
  await run(spark, [...sparkArgvPrefix, "daemon", "status", "--json"], {
    cwd: installRoot,
    env: environment,
  });
  await run(spark, [...sparkArgvPrefix, "daemon", "stop", "--yes"], {
    cwd: installRoot,
    env: environment,
  });
  const port = await availablePort();
  console.log("Starting installed Cockpit health probe...");
  const cockpit = spawn(spark, [...sparkArgvPrefix, "cockpit"], {
    cwd: installRoot,
    env: {
      ...environment,
      HOST: "127.0.0.1",
      PORT: String(port),
      ORIGIN: `http://127.0.0.1:${port}`,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cockpitOutput = { stderr: "" };
  cockpit.stderr.setEncoding("utf8");
  cockpit.stderr.on("data", (chunk) => {
    cockpitOutput.stderr += chunk;
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/api/v1/health`, cockpit, cockpitOutput);
  } finally {
    terminateProcessTree(cockpit);
    await new Promise((resolveExit) => {
      if (cockpit.exitCode !== null || cockpit.signalCode !== null) {
        resolveExit();
        return;
      }
      cockpit.once("exit", resolveExit);
    });
  }
  const installedFileCount = await (async function countFiles(directory) {
    let count = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) count += await countFiles(resolve(directory, entry.name));
      else if (entry.isFile()) count += 1;
    }
    return count;
  })(resolve(installRoot, "node_modules/@zendev-lab/spark"));
  console.log(
    `Npm product tarball install smoke passed (${tarball}, ${packed.size} bytes, ${installedFileCount} product files).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
