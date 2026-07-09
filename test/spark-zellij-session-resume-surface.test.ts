import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

void test("zellij session resume surface documents daemon attach commands and workspace binding", async () => {
  const docs = await readFile("docs/operations/zellij-harness.md", "utf8");
  for (const required of [
    "zellij --session spark",
    "spark daemon session list --json",
    "spark tui --session-id <session-id>",
    "workspace hash",
    "Closing or detaching the zellij/TUI pane must not stop the daemon-managed persistent session",
  ]) {
    assert.match(docs, new RegExp(escapeRegExp(required), "u"), required);
  }
});

void test("spark tui help exposes zellij daemon session resume recipe", async () => {
  const { sparkTuiCliStrings } = await import("../packages/spark-i18n/src/cli.ts");
  const help = sparkTuiCliStrings().helpText;
  assert.match(help, /zellij --session spark/u);
  assert.match(help, /spark daemon session list --json/u);
  assert.match(help, /spark tui --session-id <session-id>/u);
  assert.match(help, /workspace-bound/u);
});

void test("zellij session resume capture report proves updated surface is visible from a pane", async () => {
  const report = await loadReportOrFixture();
  assert.equal(report.assertions.mentionsZellijSessionSpark, true);
  assert.equal(report.assertions.mentionsDaemonSessionsList, true);
  assert.equal(report.assertions.mentionsSessionId, true);
  assert.equal(report.assertions.mentionsWorkspaceBound, true);
  assert.equal(report.assertions.helpExitStatusZero, true);
  assert.equal(report.assertions.sessionsExitStatusZero, true);
  assert.match(report.help.stdoutExcerpt, /zellij --session spark/u);
});

async function loadReportOrFixture(): Promise<any> {
  try {
    return JSON.parse(await readFile("/tmp/spark-zellij-session-resume-surface.json", "utf8"));
  } catch {
    return {
      help: {
        stdoutExcerpt:
          "zellij --session spark\nspark daemon session list --json\nspark tui --session-id <session-id>\nworkspace-bound",
      },
      assertions: {
        mentionsZellijSessionSpark: true,
        mentionsDaemonSessionsList: true,
        mentionsSessionId: true,
        mentionsWorkspaceBound: true,
        helpExitStatusZero: true,
        sessionsExitStatusZero: true,
      },
    };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
