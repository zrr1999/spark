import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piFilesExtension, {
  registerPiFilesTools,
  truncateHead,
  truncateLine,
  applyEditsToNormalizedContent,
  generateDiffString,
  walkTree,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
} from "@zendev-lab/spark-files";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolConfig {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: { cwd?: string },
  ): Promise<ToolResult>;
}

function collectTools(
  register: (api: { registerTool: (c: ToolConfig) => void }) => void,
): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  register({ registerTool: (config) => tools.set(config.name, config as ToolConfig) });
  return tools;
}

const noop = () => {};
const text = (result: ToolResult): string => result.content.map((c) => c.text).join("\n");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-files-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("spark-files default extension registers all six file tools", () => {
  const tools = collectTools(piFilesExtension);
  assert.deepEqual([...tools.keys()].sort(), ["edit", "find", "grep", "ls", "read", "write"]);
});

void test("registerPiFilesTools honors a tool subset", () => {
  const tools = collectTools((pi) => registerPiFilesTools(pi, { tools: ["read", "grep"] }));
  assert.deepEqual([...tools.keys()].sort(), ["grep", "read"]);
});

void test("read returns file content and honors offset/limit continuation", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile(join(dir, "f.txt"), lines.join("\n"), "utf-8");

    const full = await read.execute("c", { path: "f.txt" }, undefined, noop, { cwd: dir });
    assert.equal(text(full), lines.join("\n"));

    const windowed = await read.execute(
      "c",
      { path: "f.txt", offset: 3, limit: 2 },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );
    assert.match(text(windowed), /^line3\nline4/);
    assert.match(text(windowed), /6 more lines in file\. Use offset=5 to continue\./);
  });
});

void test("read reports a missing file as an error result", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const result = await read.execute("c", { path: "missing.txt" }, undefined, noop, { cwd: dir });
    assert.equal(result.isError, true);
    assert.match(text(result), /Could not read file/);
  });
});

void test("read truncates by line limit with a continuation notice", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const total = DEFAULT_MAX_LINES + 50;
    const content = Array.from({ length: total }, (_, i) => `L${i + 1}`).join("\n");
    await writeFile(join(dir, "big.txt"), content, "utf-8");
    const result = await read.execute("c", { path: "big.txt" }, undefined, noop, { cwd: dir });
    assert.match(text(result), new RegExp(`Showing lines 1-${DEFAULT_MAX_LINES} of ${total}`));
    assert.equal((result.details?.truncation as { truncated?: boolean })?.truncated, true);
  });
});

void test("write creates parent dirs and overwrites", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const result = await write.execute(
      "c",
      { path: "nested/deep/out.txt", content: "hello" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(result), /Successfully wrote 5 bytes/);
    assert.equal(await readFile(join(dir, "nested/deep/out.txt"), "utf-8"), "hello");
  });
});

void test("edit applies multiple disjoint replacements and emits a diff", async () => {
  await withTempDir(async (dir) => {
    const edit = collectTools(piFilesExtension).get("edit")!;
    await writeFile(join(dir, "code.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf-8");
    const result = await edit.execute(
      "c",
      {
        path: "code.ts",
        edits: [
          { oldText: "const a = 1;", newText: "const a = 10;" },
          { oldText: "const c = 3;", newText: "const c = 30;" },
        ],
      },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(result.isError ?? false, false);
    assert.match(text(result), /Successfully replaced 2 block\(s\) in code\.ts/);
    assert.equal(
      await readFile(join(dir, "code.ts"), "utf-8"),
      "const a = 10;\nconst b = 2;\nconst c = 30;\n",
    );
    assert.equal(typeof result.details?.diff, "string");
    assert.equal(typeof result.details?.patch, "string");
  });
});

void test("edit rejects duplicate, missing, and overlapping edits", async () => {
  await withTempDir(async (dir) => {
    const edit = collectTools(piFilesExtension).get("edit")!;
    await writeFile(join(dir, "dup.txt"), "x\nx\n", "utf-8");
    const dup = await edit.execute(
      "c",
      { path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );
    assert.equal(dup.isError, true);
    assert.match(text(dup), /occurrences/);

    await writeFile(join(dir, "one.txt"), "alpha beta gamma\n", "utf-8");
    const missing = await edit.execute(
      "c",
      { path: "one.txt", edits: [{ oldText: "nope", newText: "x" }] },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(missing.isError, true);
    assert.match(text(missing), /Could not find/);

    const overlap = await edit.execute(
      "c",
      {
        path: "one.txt",
        edits: [
          { oldText: "alpha beta", newText: "A" },
          { oldText: "beta gamma", newText: "B" },
        ],
      },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(overlap.isError, true);
    assert.match(text(overlap), /overlap/);
  });
});

void test("edit fuzzy-matches smart quotes and trailing whitespace", async () => {
  await withTempDir(async (dir) => {
    const edit = collectTools(piFilesExtension).get("edit")!;
    await writeFile(join(dir, "smart.txt"), "say \u201Chello\u201D now   \n", "utf-8");
    const result = await edit.execute(
      "c",
      { path: "smart.txt", edits: [{ oldText: 'say "hello" now', newText: "done" }] },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(result.isError ?? false, false);
    assert.match(await readFile(join(dir, "smart.txt"), "utf-8"), /done/);
  });
});

void test("ls lists alphabetically with directory suffixes", async () => {
  await withTempDir(async (dir) => {
    const ls = collectTools(piFilesExtension).get("ls")!;
    await mkdir(join(dir, "subdir"));
    await writeFile(join(dir, "b.txt"), "", "utf-8");
    await writeFile(join(dir, "a.txt"), "", "utf-8");
    const result = await ls.execute("c", {}, undefined, noop, { cwd: dir });
    assert.deepEqual(text(result).split("\n"), ["a.txt", "b.txt", "subdir/"]);
  });
});

void test("grep returns path:line: matches and respects .gitignore", async () => {
  await withTempDir(async (dir) => {
    const grep = collectTools(piFilesExtension).get("grep")!;
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n", "utf-8");
    await writeFile(join(dir, "keep.txt"), "needle here\nother\n", "utf-8");
    await writeFile(join(dir, "ignored.txt"), "needle ignored\n", "utf-8");
    const result = await grep.execute("c", { pattern: "needle" }, undefined, noop, { cwd: dir });
    assert.match(text(result), /keep\.txt:1: needle here/);
    assert.doesNotMatch(text(result), /ignored\.txt/);
  });
});

void test("grep supports literal mode, context lines, and no-match", async () => {
  await withTempDir(async (dir) => {
    const grep = collectTools(piFilesExtension).get("grep")!;
    await writeFile(join(dir, "f.txt"), "a\nb.c\nd\n", "utf-8");
    const literal = await grep.execute(
      "c",
      { pattern: "b.c", literal: true, context: 1 },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(literal), /f\.txt:2: b\.c/);
    assert.match(text(literal), /f\.txt-1- a/);
    assert.match(text(literal), /f\.txt-3- d/);

    const none = await grep.execute("c", { pattern: "zzz" }, undefined, noop, { cwd: dir });
    assert.equal(text(none), "No matches found");
  });
});

void test("find matches globs over a gitignore-aware walk", async () => {
  await withTempDir(async (dir) => {
    const find = collectTools(piFilesExtension).get("find")!;
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src/a.ts"), "", "utf-8");
    await writeFile(join(dir, "src/b.js"), "", "utf-8");
    await writeFile(join(dir, "node_modules/dep.ts"), "", "utf-8");

    const ts = await find.execute("c", { pattern: "*.ts" }, undefined, noop, { cwd: dir });
    assert.match(text(ts), /src\/a\.ts/);
    assert.doesNotMatch(text(ts), /node_modules/);
    assert.doesNotMatch(text(ts), /b\.js/);

    const none = await find.execute("c", { pattern: "*.md" }, undefined, noop, { cwd: dir });
    assert.equal(text(none), "No files found matching pattern");
  });
});

void test("walkTree skips node_modules/.git and honors limit", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, ".git/config"), "", "utf-8");
    await writeFile(join(dir, "node_modules/x.js"), "", "utf-8");
    await writeFile(join(dir, "one.txt"), "", "utf-8");
    await writeFile(join(dir, "two.txt"), "", "utf-8");
    const collected: string[] = [];
    for await (const entry of walkTree(dir)) collected.push(entry.relativePath);
    assert.deepEqual(collected.sort(), ["one.txt", "two.txt"]);
  });
});

void test("truncateHead reports first-line-exceeds-limit", () => {
  const big = "x".repeat(DEFAULT_MAX_BYTES + 10);
  const result = truncateHead(big);
  assert.equal(result.firstLineExceedsLimit, true);
  assert.equal(result.content, "");
});

void test("truncateLine caps long lines", () => {
  const { text: capped, wasTruncated } = truncateLine("y".repeat(600));
  assert.equal(wasTruncated, true);
  assert.match(capped, /\.\.\. \[truncated\]$/);
});

void test("applyEditsToNormalizedContent + generateDiffString produce a line-numbered diff", () => {
  const { baseContent, newContent } = applyEditsToNormalizedContent(
    "a\nb\nc\n",
    [{ oldText: "b", newText: "B" }],
    "x.txt",
  );
  const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);
  assert.equal(firstChangedLine, 2);
  assert.match(diff, /-2 b/);
  assert.match(diff, /\+2 B/);
});
