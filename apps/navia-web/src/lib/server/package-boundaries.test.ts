import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("package boundaries", () => {
  it("does not import runner internals from the web app", () => {
    const sourceFiles = collectSourceFiles(join(webRoot, "src"));
    const violations = sourceFiles.filter((file) =>
      readFileSync(file, "utf8").includes("@navia-dev/runner"),
    );

    expect(violations).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (/\.(svelte|ts)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}
