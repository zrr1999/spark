import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { NaviaPaths } from "./paths.js";

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodIfPossible(path, 0o700);
}

export function ensurePublicDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o755 });
}

export function ensureNaviaPathDirs(paths: NaviaPaths): void {
  ensurePrivateDir(paths.configDir);
  ensurePrivateDir(paths.dataDir);
  ensurePublicDir(paths.cacheDir);
  ensurePrivateDir(paths.stateDir);
  ensurePrivateDir(paths.runtimeDir);
  ensurePrivateDir(paths.logDir);
}

export function writePrivateFile(path: string, contents: string): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  chmodIfPossible(path, 0o600);
}

export function touchPrivateFile(path: string): void {
  ensurePrivateDir(dirname(path));
  if (!existsSync(path)) {
    closeSync(openSync(path, "w", 0o600));
  }
  chmodIfPossible(path, 0o600);
}

function chmodIfPossible(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
  }
}
