import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const sparkServerAdapters = [
  "command-submission.ts",
  "events.ts",
  "liveness.ts",
  "project-cockpit.ts",
  "projection-services.ts",
  "runtime-registration.ts",
  "runtime-ws.ts",
  "search.ts",
];

describe("package boundaries", () => {
  it("keeps migrated server coordination modules as spark-server adapters", () => {
    for (const adapter of sparkServerAdapters) {
      const source = readFileSync(join(webRoot, "src/lib/server", adapter), "utf8").trim();
      expect(source).toMatch(/^export \* from "@zendev-lab\/spark-server\//u);
    }
  });

  it("does not import Spark daemon internals from the cockpit app", () => {
    const sourceFiles = collectSourceFiles(join(webRoot, "src"));
    const violations = sourceFiles.filter((file) =>
      /from\s+["']@zendev-lab\/spark-daemon/u.test(readFileSync(file, "utf8")),
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
