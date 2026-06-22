import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function ensureLocalSparkDirectory(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".spark"), { recursive: true });
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

export async function shouldMaterializeSparkMd(cwd: string): Promise<boolean> {
  return pathExists(join(cwd, ".git"));
}

export async function readActiveSparkMd(cwd: string): Promise<string | undefined> {
  const sparkMdPath = await findUpExisting(cwd, "SPARK.md");
  if (sparkMdPath) return readFile(sparkMdPath, "utf8");
  return undefined;
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

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
