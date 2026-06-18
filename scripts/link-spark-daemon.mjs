#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "apps/spark-daemon/dist/cli.js");

if (!existsSync(cliPath)) {
  console.error(`Spark daemon CLI is not built: ${cliPath}`);
  console.error("Run `pnpm run spark-daemon:install` to build and link the daemon CLI.");
  process.exit(1);
}

function globalBinDir() {
  try {
    const output = execFileSync("pnpm", ["bin", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (output.length > 0) return output;
  } catch {
    // Fall through to the local macOS default used by pnpm in this environment.
  }

  const pnpmHome = process.env.PNPM_HOME;
  if (pnpmHome && pnpmHome.length > 0) {
    return path.basename(pnpmHome) === "bin" ? pnpmHome : path.join(pnpmHome, "bin");
  }

  return path.join(homedir(), "Library/pnpm/bin");
}

const binDir = globalBinDir();
const linkPath = path.join(binDir, "spark-daemon");

mkdirSync(binDir, { recursive: true });
chmodSync(cliPath, 0o755);

if (existsSync(linkPath)) {
  const current = lstatSync(linkPath);
  if (!current.isSymbolicLink()) {
    console.error(`Refusing to overwrite non-symlink: ${linkPath}`);
    process.exit(1);
  }

  const target = path.resolve(binDir, readlinkSync(linkPath));
  if (target !== cliPath) {
    console.error(`Replacing existing spark-daemon symlink: ${linkPath} -> ${target}`);
  }
  rmSync(linkPath);
}

symlinkSync(cliPath, linkPath);

console.log(`Linked spark-daemon -> ${cliPath}`);
console.log(`Global bin: ${binDir}`);
console.log(`If your shell cannot find spark-daemon, add this directory to PATH.`);
