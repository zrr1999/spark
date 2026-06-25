/**
 * Gitignore-aware filesystem walker used by the pure-JS `grep` and `find`
 * tools. No `rg`/`fd` subprocess is spawned, so the tools work on hosts
 * without those binaries (matching Spark's "local + explicit" posture).
 *
 * Ignore semantics:
 *   - `.git` and `node_modules` are always skipped.
 *   - `.gitignore` files are honoured hierarchically: each directory's
 *     patterns apply to paths beneath it, using the `ignore` package.
 *   - Hidden entries are walked (Pi passes `--hidden` to rg/fd), but ignored
 *     paths are still pruned.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

const ALWAYS_IGNORE = new Set([".git", "node_modules"]);

export interface WalkEntry {
  /** Absolute path. */
  absolutePath: string;
  /** Path relative to the walk root, using POSIX separators. */
  relativePath: string;
  isDirectory: boolean;
}

export interface WalkOptions {
  /** Stop after collecting this many file entries (directories are not counted). */
  limit?: number;
  /** Abort signal; the walk stops promptly when aborted. */
  signal?: AbortSignal;
  /** Include directory entries in the yielded results. Default false. */
  includeDirectories?: boolean;
}

interface IgnoreLayer {
  /** Directory that owns these rules, relative to the walk root (POSIX, "" = root). */
  baseDir: string;
  ig: Ignore;
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

async function loadGitignore(dir: string): Promise<Ignore | undefined> {
  try {
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    return ignore().add(content);
  } catch {
    return undefined;
  }
}

/**
 * Test whether a path relative to the walk root is ignored by any active
 * .gitignore layer. `relPath` uses POSIX separators.
 */
function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  for (const layer of layers) {
    let candidate: string;
    if (layer.baseDir === "") {
      candidate = relPath;
    } else if (relPath === layer.baseDir) {
      continue;
    } else if (relPath.startsWith(`${layer.baseDir}/`)) {
      candidate = relPath.slice(layer.baseDir.length + 1);
    } else {
      continue;
    }
    if (!candidate) continue;
    const result = layer.ig.test(isDir ? `${candidate}/` : candidate);
    if (result.ignored && !result.unignored) return true;
  }
  return false;
}

/**
 * Walk `root` depth-first, yielding non-ignored file entries (and optionally
 * directories) in a stable, case-insensitive alphabetical order per directory.
 */
export async function* walkTree(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  const rootIgnore = await loadGitignore(root);
  const baseLayers: IgnoreLayer[] = rootIgnore ? [{ baseDir: "", ig: rootIgnore }] : [];
  let yielded = 0;

  async function* walk(dir: string, layers: IgnoreLayer[]): AsyncGenerator<WalkEntry> {
    if (options.signal?.aborted) throw new Error("Operation aborted");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    for (const name of names) {
      if (options.signal?.aborted) throw new Error("Operation aborted");
      if (yielded >= limit) return;
      if (ALWAYS_IGNORE.has(name)) continue;

      const absolutePath = join(dir, name);
      const relPath = toPosix(relative(root, absolutePath));
      let isDir = false;
      try {
        isDir = (await stat(absolutePath)).isDirectory();
      } catch {
        continue;
      }
      if (isIgnored(layers, relPath, isDir)) continue;

      if (isDir) {
        if (options.includeDirectories) {
          yield { absolutePath, relativePath: relPath, isDirectory: true };
        }
        const childIgnore = await loadGitignore(absolutePath);
        const childLayers = childIgnore
          ? [...layers, { baseDir: relPath, ig: childIgnore }]
          : layers;
        yield* walk(absolutePath, childLayers);
      } else {
        yield { absolutePath, relativePath: relPath, isDirectory: false };
        yielded += 1;
      }
    }
  }

  yield* walk(root, baseLayers);
}
