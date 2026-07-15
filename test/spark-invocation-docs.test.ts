import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { sparkDaemonHelpText } from "../apps/spark-tui/src/cli/daemon.ts";

const terminologyScript = resolve("scripts/check-doc-terminology.mjs");
const authoritativeDocs = [
  "README.md",
  "apps/spark-daemon/README.md",
  "apps/spark-tui/README.md",
  "docs/specs/command-planes.md",
  "docs/specs/turn.md",
] as const;

void test("authoritative turn and host docs expose invocation status, stream, and cancel only", async () => {
  for (const path of authoritativeDocs) {
    const content = await readFile(path, "utf8");
    assert.match(content, /invocation(?:Id|-id)/u, path);
    assert.match(content, /invocation status|`turn\.status`/u, path);
    assert.match(content, /invocation stream|`turn\.stream`/u, path);
    assert.match(content, /invocation cancel|`turn\.cancel`/u, path);
    assert.doesNotMatch(content, /daemon\.queue|spark daemon queue/iu, path);
    assert.doesNotMatch(content, /inbox[ /,]+processed[ /,]+failed/iu, path);
  }
});

void test("generated daemon help exposes invocation operations without legacy directory commands", () => {
  const help = sparkDaemonHelpText();
  assert.match(help, /spark daemon invocation status <invocation-id>/u);
  assert.match(help, /spark daemon invocation stream <invocation-id>/u);
  assert.match(help, /spark daemon invocation cancel <invocation-id>/u);
  assert.doesNotMatch(help, /spark daemon queue|daemon\.queue/iu);
  assert.doesNotMatch(help, /inbox[ /,]+processed[ /,]+failed/iu);
  assert.doesNotMatch(help, /(?:inbox|processed|failed)[ -]director/iu);
});

void test("invocation terminology checker reports only classified migration/archive sources", () => {
  const result = runTerminologyCheck(resolve("."));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /invocation terminology report/u);
  assert.match(result.stdout, /legacy archive\/migration source/u);
  assert.doesNotMatch(result.stdout, /unclassified/u);
});

void test("invocation terminology checker rejects public docs, CLI help, and protocol fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-invocation-terminology-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "packages", "spark-i18n", "src"), { recursive: true });
    await mkdir(join(root, "packages", "spark-protocol", "src", "fixtures"), {
      recursive: true,
    });
    await writeFile(join(root, "README.md"), "Use spark daemon queue for work.\n", "utf8");
    await writeFile(
      join(root, "packages", "spark-i18n", "src", "cli.ts"),
      'export const help = "spark daemon queue";\n',
      "utf8",
    );
    await writeFile(
      join(root, "packages", "spark-protocol", "src", "fixtures", "legacy.json"),
      JSON.stringify({ method: "daemon.queue", taskFileName: "turn.json" }),
      "utf8",
    );

    const result = runTerminologyCheck(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retired queue CLI command/u);
    assert.match(result.stderr, /retired daemon\.queue RPC/u);
    assert.match(result.stderr, /retired taskFileName identity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("invocation terminology checker rejects migration history in active docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-invocation-migration-doc-"));
  try {
    await mkdir(join(root, "docs", "operations"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Example\n", "utf8");
    await writeFile(
      join(root, "docs", "operations", "invocation-lifecycle.md"),
      "Legacy migration source: the queue directory is archived after import.\n",
      "utf8",
    );

    const result = runTerminologyCheck(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retired queue-shaped execution terminology/u);
    assert.match(result.stderr, /unclassified daemon queue terminology/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runTerminologyCheck(root: string) {
  return spawnSync(process.execPath, [terminologyScript], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_DOC_TERMINOLOGY_ROOT: root },
    encoding: "utf8",
  });
}
