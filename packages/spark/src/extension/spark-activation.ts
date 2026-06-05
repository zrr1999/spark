import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { defaultArtifactStore } from "pi-artifacts";

export interface SparkActivation {
  active: boolean;
  reason: string;
}

export async function hasLocalSparkDirectory(cwd: string): Promise<boolean> {
  return pathExists(join(cwd, ".spark"));
}

export async function hasNonSparkProjectFiles(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".spark" || entry.name === ".git") continue;
      if (entry.name === "node_modules" || entry.name === ".pi") continue;
      if (entry.name.startsWith(".DS_Store")) continue;
      if (entry.isFile() || entry.isDirectory()) return true;
    }
    return false;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export async function detectSparkActivation(cwd: string): Promise<SparkActivation> {
  if (!(await hasLocalSparkDirectory(cwd))) return { active: false, reason: "no .spark" };
  if (await pathExists(join(cwd, ".spark", "projects.json")))
    return { active: true, reason: ".spark/projects.json" };
  if (await pathExists(join(cwd, "SPARK.md"))) return { active: true, reason: "SPARK.md" };
  if (await isWhitelistedByConfig(cwd))
    return { active: true, reason: "~/.config/spark/config.toml" };
  return { active: false, reason: "none" };
}

export async function shouldMaterializeSparkMd(cwd: string): Promise<boolean> {
  return pathExists(join(cwd, ".git"));
}

export async function readActiveSparkMd(cwd: string): Promise<string | undefined> {
  const sparkMdPath = await findUpExisting(cwd, "SPARK.md");
  if (sparkMdPath) return readFile(sparkMdPath, "utf8");
  const store = defaultArtifactStore(cwd);
  const [latest] = (await store.list({ kind: "spark-md" })).slice(-1);
  if (!latest) return undefined;
  return store.getBody(latest.ref);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function isWhitelistedByConfig(cwd: string): Promise<boolean> {
  const configPath = join(homedir(), ".config", "spark", "config.toml");
  try {
    const config = await readFile(configPath, "utf8");
    if (/enabled\s*=\s*false/.test(config)) return false;
    const dirs = [...config.matchAll(/"([^"]+)"/g)].map((match) =>
      resolve(expandHome(match[1] ?? "")),
    );
    const resolved = resolve(cwd);
    return dirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}/`));
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function findUpExisting(cwd: string, relativePath: string): Promise<string | null> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, relativePath);
    if (await pathExists(candidate)) return candidate;
    const parent = dirname(current);
    if (current === parent) return null;
    current = parent;
  }
}

function expandHome(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
