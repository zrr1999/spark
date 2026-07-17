import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  parameters?: unknown;
  policy?: {
    effect?: string;
    executionMode?: string;
    domains?: readonly string[];
    phases?: readonly string[];
    approval?: string;
  };
  effect?: "read" | "local_write" | "external_write" | "destructive";
  executionMode?: "sequential" | "parallel";
  promptGuidelines?: string[];
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

interface ReadLineAnchor {
  line: number;
  hash: string;
  anchor: string;
  text: string;
}

interface ReadDetails {
  version: string;
  sizeBytes: number;
  bom: "utf8" | "none";
  lineEnding: "none" | "lf" | "crlf" | "cr" | "mixed";
  totalLines: number;
  window: {
    startLine: number;
    endLine?: number;
    nextOffset?: number;
    requestedLimit?: number;
    anchors: ReadLineAnchor[];
  };
}

function readDetails(result: ToolResult): ReadDetails {
  return result.details as unknown as ReadDetails;
}

function expectedReadText(result: ToolResult, notice?: string): string {
  const details = readDetails(result);
  return [
    `[File version: ${details.version}]`,
    details.window.anchors.map((anchor) => anchor.anchor).join("\n"),
    notice,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

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
  for (const name of ["read", "ls", "grep", "find"]) {
    assert.equal(tools.get(name)?.effect, "read", name);
    assert.equal(tools.get(name)?.executionMode, "parallel", name);
    assert.equal(tools.get(name)?.policy?.effect, "read", `${name} canonical policy`);
    assert.equal(tools.get(name)?.policy?.approval, "none", `${name} approval policy`);
  }
  for (const name of ["write", "edit"]) {
    assert.equal(tools.get(name)?.effect, "local_write", name);
    assert.equal(tools.get(name)?.executionMode, "sequential", name);
    assert.deepEqual(tools.get(name)?.policy?.phases, ["implement"], `${name} phases`);
  }
  assert.match(tools.get("read")?.promptGuidelines?.join("\n") ?? "", /always returns/u);
  assert.match(tools.get("write")?.promptGuidelines?.join("\n") ?? "", /Every write must/u);
});

void test("registerPiFilesTools honors a tool subset", () => {
  const tools = collectTools((pi) => registerPiFilesTools(pi, { tools: ["read", "grep"] }));
  assert.deepEqual([...tools.keys()].sort(), ["grep", "read"]);
});

void test("read always returns one versioned anchored format and honors continuation", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile(join(dir, "f.txt"), lines.join("\n"), "utf-8");

    const full = await read.execute("c", { path: "f.txt" }, undefined, noop, { cwd: dir });
    assert.equal(text(full), expectedReadText(full));

    const windowed = await read.execute(
      "c",
      { path: "f.txt", offset: 3, limit: 2 },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );
    assert.equal(
      text(windowed),
      expectedReadText(windowed, "[6 more lines in file. Use offset=5 to continue.]"),
    );
    assert.deepEqual(readDetails(windowed).window, {
      startLine: 3,
      endLine: 4,
      nextOffset: 5,
      requestedLimit: 2,
      anchors: readDetails(windowed).window.anchors,
    });
  });
});

void test("read offset and limit are positive integers in schema and at runtime", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const properties = (
      read.parameters as {
        additionalProperties?: boolean;
        properties?: Record<string, { type?: string; minimum?: number; description?: string }>;
      }
    ).properties;
    assert.equal(
      (read.parameters as { additionalProperties?: boolean }).additionalProperties,
      false,
    );
    assert.equal(properties?.mode, undefined);
    assert.deepEqual(properties?.offset, {
      description: "Line number to start reading from (1-indexed)",
      minimum: 1,
      type: "integer",
    });
    assert.deepEqual(properties?.limit, {
      description: "Maximum number of lines to read",
      minimum: 1,
      type: "integer",
    });
    await writeFile(join(dir, "window.txt"), "one\ntwo", "utf-8");

    for (const params of [
      { path: "window.txt", offset: 0 },
      { path: "window.txt", offset: -1 },
      { path: "window.txt", offset: 1.5 },
      { path: "window.txt", limit: 0 },
      { path: "window.txt", limit: -1 },
      { path: "window.txt", limit: 1.5 },
    ]) {
      const result = await read.execute("invalid-window", params, undefined, noop, { cwd: dir });
      assert.equal(result.isError, true, JSON.stringify(params));
      assert.equal(result.details?.code, "INVALID_READ_WINDOW", JSON.stringify(params));
    }
  });
});

void test("read exposes model-visible version, anchors, and continuation", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const lines = Array.from({ length: 6 }, (_, index) => `line${index + 1}`);
    await writeFile(join(dir, "visible.txt"), lines.join("\n"), "utf-8");

    const result = await read.execute(
      "c",
      { path: "visible.txt", offset: 2, limit: 2 },
      undefined,
      noop,
      { cwd: dir },
    );
    const details = readDetails(result);
    assert.equal(
      text(result),
      [
        `[File version: ${details.version}]`,
        details.window.anchors.map((anchor) => anchor.anchor).join("\n"),
        "[3 more lines in file. Use offset=4 to continue.]",
      ].join("\n\n"),
    );
    assert.match(text(result), /^\[File version: sha256:[0-9a-f]{64}\]/u);
    assert.match(text(result), /\n\n2#[0-9a-f]{12}:line2\n3#[0-9a-f]{12}:line3\n\n/u);
  });
});

void test("read returns stable content versions and copyable anchors across windows", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const path = join(dir, "anchored.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf-8");

    const full = await read.execute("c", { path: "anchored.txt" }, undefined, noop, {
      cwd: dir,
    });
    const windowed = await read.execute(
      "c",
      { path: "anchored.txt", offset: 2, limit: 1 },
      undefined,
      noop,
      { cwd: dir },
    );
    const fullDetails = readDetails(full);
    const windowDetails = readDetails(windowed);
    assert.match(fullDetails.version, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(windowDetails.version, fullDetails.version);
    assert.deepEqual(windowDetails.window.anchors[0], fullDetails.window.anchors[1]);
    assert.match(windowDetails.window.anchors[0]!.anchor, /^2#[0-9a-f]{12}:beta$/u);

    await writeFile(path, "alpha\nbeta\nchanged", "utf-8");
    const changed = await read.execute(
      "c",
      { path: "anchored.txt", offset: 2, limit: 1 },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.notEqual(readDetails(changed).version, fullDetails.version);
    assert.deepEqual(readDetails(changed).window.anchors[0], windowDetails.window.anchors[0]);
  });
});

void test("read reports BOM and CRLF metadata while rendering logical anchors", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const path = join(dir, "windows.txt");
    const original = "\uFEFFalpha\r\nbeta\r\n";
    await writeFile(path, original, "utf-8");

    const result = await read.execute("c", { path: "windows.txt" }, undefined, noop, {
      cwd: dir,
    });
    const details = readDetails(result);
    assert.equal(text(result), expectedReadText(result));
    assert.doesNotMatch(text(result), /\r/u);
    assert.doesNotMatch(text(result), /\uFEFF/u);
    assert.equal(details.bom, "utf8");
    assert.equal(details.lineEnding, "crlf");
    assert.equal(details.sizeBytes, Buffer.byteLength(original, "utf-8"));
    assert.deepEqual(
      details.window.anchors.slice(0, 2).map((anchor) => anchor.text),
      ["alpha", "beta"],
    );

    await writeFile(path, "alpha\nbeta\n", "utf-8");
    const normalized = await read.execute("c", { path: "windows.txt" }, undefined, noop, {
      cwd: dir,
    });
    assert.notEqual(readDetails(normalized).version, details.version);
    assert.deepEqual(
      readDetails(normalized)
        .window.anchors.slice(0, 2)
        .map((anchor) => anchor.hash),
      details.window.anchors.slice(0, 2).map((anchor) => anchor.hash),
    );
  });
});

void test("read reports CR-only and mixed line endings with one logical-anchor format", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const crOnly = "alpha\rbeta\rgamma\r";
    await writeFile(join(dir, "classic-mac.txt"), crOnly, "utf-8");

    const fullCr = await read.execute("cr-full", { path: "classic-mac.txt" }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(text(fullCr), expectedReadText(fullCr));
    assert.equal(readDetails(fullCr).lineEnding, "cr");
    assert.equal(readDetails(fullCr).totalLines, 4);
    assert.deepEqual(
      readDetails(fullCr).window.anchors.map((anchor) => anchor.text),
      ["alpha", "beta", "gamma", ""],
    );

    const crWindow = await read.execute(
      "cr-window",
      { path: "classic-mac.txt", offset: 2, limit: 2 },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(
      text(crWindow),
      expectedReadText(crWindow, "[1 more lines in file. Use offset=4 to continue.]"),
    );
    assert.deepEqual(
      readDetails(crWindow).window.anchors.map((anchor) => anchor.text),
      ["beta", "gamma"],
    );

    const mixed = "one\r\ntwo\rthree\nfour";
    await writeFile(join(dir, "mixed.txt"), mixed, "utf-8");
    const fullMixed = await read.execute("mixed-full", { path: "mixed.txt" }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(text(fullMixed), expectedReadText(fullMixed));
    assert.equal(readDetails(fullMixed).lineEnding, "mixed");
    assert.deepEqual(
      readDetails(fullMixed).window.anchors.map((anchor) => anchor.text),
      ["one", "two", "three", "four"],
    );
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

void test("read rejects invalid UTF-8 instead of returning replacement characters", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    await writeFile(join(dir, "binary.dat"), Buffer.from([0xff, 0xfe, 0x00]));
    const result = await read.execute("invalid-utf8", { path: "binary.dat" }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(result.isError, true);
    assert.equal(result.details?.code, "INVALID_UTF8");
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

void test("read applies the byte limit to the final anchored output", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const lines = Array.from(
      { length: 1_500 },
      (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(20)}`,
    );
    await writeFile(join(dir, "anchored-budget.txt"), lines.join("\n"), "utf-8");

    const result = await read.execute(
      "anchored-budget",
      { path: "anchored-budget.txt" },
      undefined,
      noop,
      { cwd: dir },
    );
    const truncation = result.details?.truncation as { truncatedBy?: string } | undefined;

    assert.ok(Buffer.byteLength(text(result), "utf8") <= DEFAULT_MAX_BYTES);
    assert.match(text(result), /50\.0KB output limit/u);
    assert.equal(truncation?.truncatedBy, "bytes");
    assert.ok(readDetails(result).window.anchors.length < lines.length);
    assert.equal(
      readDetails(result).window.nextOffset,
      readDetails(result).window.anchors.length + 1,
    );
  });
});

void test("write requires one explicit version-precondition schema", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const schema = write.parameters as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "content",
      "expectedVersion",
      "path",
    ]);
    const expectedVersionProperty = schema.properties?.expectedVersion as
      | { pattern?: string }
      | undefined;
    assert.equal(expectedVersionProperty?.pattern, "^(?:missing|sha256:[0-9a-f]{64})$");
    assert.deepEqual([...(schema.required ?? [])].sort(), ["content", "expectedVersion", "path"]);

    const result = await write.execute(
      "blind-write",
      { path: "blind.txt", content: "must not land" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(result.isError, true);
    assert.equal(result.details?.code, "INVALID_EXPECTED_VERSION");
    await assert.rejects(readFile(join(dir, "blind.txt"), "utf-8"), /ENOENT/u);
  });
});

void test("write creates parent directories with a create-only precondition", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const result = await write.execute(
      "c",
      { path: "nested/deep/out.txt", content: "hello", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(result), /Successfully wrote 5 bytes/);
    assert.equal(await readFile(join(dir, "nested/deep/out.txt"), "utf-8"), "hello");
    assert.equal(result.details?.atomic, true);
    const version = String(result.details?.version);
    assert.match(version, /^sha256:[0-9a-f]{64}$/u);
    assert.match(text(result), new RegExp(`\\[File version: ${version}\\]`, "u"));
  });
});

void test("write atomically replaces an existing file and preserves its mode", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    const path = join(dir, "atomic.txt");
    await writeFile(path, "before", "utf-8");
    await chmod(path, 0o600);
    const before = await stat(path);
    const snapshot = await read.execute(
      "read-before-write",
      { path: "atomic.txt" },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );

    const result = await write.execute(
      "c",
      {
        path: "atomic.txt",
        content: "after",
        expectedVersion: readDetails(snapshot).version,
      },
      undefined,
      noop,
      { cwd: dir },
    );
    const after = await stat(path);
    assert.equal(result.isError ?? false, false);
    assert.notEqual(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf-8"), "after");
    assert.deepEqual(await readdir(dir), ["atomic.txt"]);
  });
});

void test("write refuses to replace a symbolic-link target", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const target = join(dir, "target.txt");
    const linked = join(dir, "linked.txt");
    await writeFile(target, "target content", "utf-8");
    await symlink("target.txt", linked);

    const result = await write.execute(
      "symlink-write",
      { path: "linked.txt", content: "replacement", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );

    assert.equal(result.isError, true);
    assert.match(text(result), /Refusing to atomically replace symbolic link/u);
    assert.equal((await lstat(linked)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf-8"), "target content");
    assert.deepEqual((await readdir(dir)).sort(), ["linked.txt", "target.txt"]);
  });
});

void test("atomic replacement detaches one hard-link name without mutating its sibling", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    const replaced = join(dir, "replaced.txt");
    const sibling = join(dir, "sibling.txt");
    await writeFile(replaced, "shared inode", "utf-8");
    await link(replaced, sibling);
    assert.equal((await stat(replaced)).ino, (await stat(sibling)).ino);
    const snapshot = await read.execute(
      "read-hard-link",
      { path: "replaced.txt" },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );

    const result = await write.execute(
      "hard-link-write",
      {
        path: "replaced.txt",
        content: "new inode",
        expectedVersion: readDetails(snapshot).version,
      },
      undefined,
      noop,
      { cwd: dir },
    );

    assert.equal(result.isError ?? false, false);
    assert.equal(await readFile(replaced, "utf-8"), "new inode");
    assert.equal(await readFile(sibling, "utf-8"), "shared inode");
    assert.notEqual((await stat(replaced)).ino, (await stat(sibling)).ino);
  });
});

void test("write rejects a stale expectedVersion without changing the file", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    const path = join(dir, "shared.txt");
    await writeFile(path, "version one", "utf-8");
    const initial = await read.execute("c", { path: "shared.txt" }, undefined, noop, {
      cwd: dir,
    });
    const expectedVersion = readDetails(initial).version;
    const guarded = await write.execute(
      "c",
      { path: "shared.txt", content: "version two", expectedVersion },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(guarded.isError ?? false, false);
    assert.equal(guarded.details?.previousVersion, expectedVersion);
    const guardedVersion = String(guarded.details?.version);
    await writeFile(path, "external update", "utf-8");

    const result = await write.execute(
      "c",
      { path: "shared.txt", content: "stale update", expectedVersion: guardedVersion },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(result.isError, true);
    assert.equal(result.details?.code, "VERSION_CONFLICT");
    assert.equal(result.details?.expectedVersion, guardedVersion);
    assert.notEqual(result.details?.actualVersion, guardedVersion);
    assert.equal(result.details?.retry, "read_then_retry");
    assert.equal(await readFile(path, "utf-8"), "external update");
  });
});

void test("write supports create-only expectedVersion for new files", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const created = await write.execute(
      "c",
      { path: "new.txt", content: "first", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(created.isError ?? false, false);
    assert.equal(created.details?.previousVersion, "missing");

    const conflict = await write.execute(
      "c",
      { path: "new.txt", content: "second", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(conflict.isError, true);
    assert.equal(conflict.details?.code, "VERSION_CONFLICT");
    assert.equal(await readFile(join(dir, "new.txt"), "utf-8"), "first");
  });
});

void test("concurrent create-only writes commit exactly one file", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const results = await Promise.all(
      ["alpha", "beta"].map((content, index) =>
        write.execute(
          `create-only-${index}`,
          { path: "exclusive.txt", content, expectedVersion: "missing" },
          undefined,
          noop,
          { cwd: dir },
        ),
      ),
    );

    assert.equal(results.filter((result) => result.isError !== true).length, 1);
    const conflict = results.find((result) => result.isError === true);
    assert.equal(conflict?.details?.code, "VERSION_CONFLICT");
    assert.match(await readFile(join(dir, "exclusive.txt"), "utf-8"), /^(alpha|beta)$/u);
    assert.deepEqual(await readdir(dir), ["exclusive.txt"]);
  });
});

void test("concurrent writes with one expectedVersion commit exactly one replacement", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    await writeFile(join(dir, "contended.txt"), "initial", "utf-8");
    const snapshot = await read.execute(
      "read-contended",
      { path: "contended.txt" },
      undefined,
      noop,
      { cwd: dir },
    );
    const expectedVersion = readDetails(snapshot).version;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        write.execute(
          `contended-${index}`,
          { path: "contended.txt", content: `writer-${index}`, expectedVersion },
          undefined,
          noop,
          { cwd: dir },
        ),
      ),
    );

    assert.equal(results.filter((result) => result.isError !== true).length, 1);
    assert.equal(
      results.filter((result) => result.details?.code === "VERSION_CONFLICT").length,
      19,
    );
    assert.match(await readFile(join(dir, "contended.txt"), "utf-8"), /^writer-\d+$/u);
    assert.deepEqual(await readdir(dir), ["contended.txt"]);
  });
});

void test("concurrent writes through a symlinked parent share one version lock", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    await mkdir(join(dir, "real"));
    await symlink("real", join(dir, "alias"));
    await writeFile(join(dir, "real", "shared.txt"), "initial", "utf-8");
    const snapshot = await read.execute(
      "read-aliased",
      { path: "real/shared.txt" },
      undefined,
      noop,
      { cwd: dir },
    );
    const expectedVersion = readDetails(snapshot).version;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        write.execute(
          `aliased-${index}`,
          {
            path: `${index % 2 === 0 ? "real" : "alias"}/shared.txt`,
            content: `writer-${index}`,
            expectedVersion,
          },
          undefined,
          noop,
          { cwd: dir },
        ),
      ),
    );

    assert.equal(results.filter((result) => result.isError !== true).length, 1);
    assert.equal(
      results.filter((result) => result.details?.code === "VERSION_CONFLICT").length,
      19,
    );
  });
});

void test("a queued write can be aborted without blocking the path mutex", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const first = write.execute(
      "first-queued-write",
      { path: "abortable.txt", content: "first", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    const controller = new AbortController();
    const aborted = write.execute(
      "aborted-queued-write",
      { path: "abortable.txt", content: "must not commit", expectedVersion: "missing" },
      controller.signal,
      noop,
      { cwd: dir },
    );
    controller.abort();

    const [firstResult, abortedResult] = await Promise.all([first, aborted]);
    assert.equal(firstResult.isError ?? false, false);
    assert.equal(abortedResult.isError, true);
    assert.match(text(abortedResult), /Operation aborted/u);
    assert.equal(await readFile(join(dir, "abortable.txt"), "utf-8"), "first");
    assert.deepEqual(await readdir(dir), ["abortable.txt"]);
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

void test("ls summarizes large directories when shorter", async () => {
  await withTempDir(async (dir) => {
    const ls = collectTools(piFilesExtension).get("ls")!;
    await mkdir(join(dir, "many"));
    for (let i = 0; i < 35; i += 1) {
      await writeFile(
        join(dir, "many", `very-long-file-name-${String(i).padStart(2, "0")}.txt`),
        "",
        "utf-8",
      );
    }

    const result = await ls.execute("c", { path: "many" }, undefined, noop, { cwd: dir });
    assert.equal(result.details?.grouped, "summary");
    assert.match(text(result), /entries=35 dirs=0 files=35/);
    assert.match(text(result), /very-long-file-name-00\.txt/);
    assert.match(text(result), /\+23 more/);
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

void test("grep groups large same-file match output with per-file overflow", async () => {
  await withTempDir(async (dir) => {
    const grep = collectTools(piFilesExtension).get("grep")!;
    await writeFile(
      join(dir, "long-match-file.txt"),
      Array.from({ length: 12 }, (_, i) => `needle ${i + 1}`).join("\n"),
      "utf-8",
    );

    const result = await grep.execute("c", { pattern: "needle", limit: 20 }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(result.details?.grouped, "by_file");
    assert.match(text(result), /long-match-file\.txt \(12\)/);
    assert.match(text(result), /  long-match-file\.txt:1: needle 1/);
    assert.match(text(result), /\+4 more in long-match-file\.txt/);
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

void test("find groups large results by directory when shorter", async () => {
  await withTempDir(async (dir) => {
    const find = collectTools(piFilesExtension).get("find")!;
    await mkdir(join(dir, "src"));
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(dir, "src", `long-file-name-${i}.ts`), "", "utf-8");
    }

    const result = await find.execute("c", { pattern: "*.ts" }, undefined, noop, { cwd: dir });
    assert.equal(result.details?.grouped, "by_directory");
    assert.match(text(result), /src\/ \(12\)/);
    assert.match(text(result), /long-file-name-0\.ts/);
    assert.match(text(result), /\+6 more/);
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

void test("truncateHead preserves CR-only and mixed separators", () => {
  assert.deepEqual(truncateHead("one\rtwo\rthree", { maxLines: 2 }), {
    content: "one\rtwo",
    truncated: true,
    truncatedBy: "lines",
    totalLines: 3,
    totalBytes: 13,
    outputLines: 2,
    outputBytes: 7,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: 2,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  assert.equal(
    truncateHead("one\r\ntwo\rthree\nfour", { maxLines: 3 }).content,
    "one\r\ntwo\rthree",
  );
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
