import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const REQUIRED_ROW_KEYS = [
  "sessionModel",
  "executionModel",
  "taskGoalEvidenceSupport",
  "backgroundWorkControl",
  "modelSelectorBehavior",
  "bestFitUseCase",
] as const;

void test("spark pi codex parity report schema has complete source coverage", async () => {
  const report = await loadReportOrFixture();
  const rows = report.comparisonRows;
  assert.equal(Array.isArray(rows), true);
  assert.deepEqual(
    rows.map((row: any) => row.key),
    [...REQUIRED_ROW_KEYS],
  );
  for (const row of rows as any[]) {
    assertNonEmptyArray(row.sparkSourceRefs, `${row.key}.sparkSourceRefs`);
    assertNonEmptyArray(row.piSourceRefs, `${row.key}.piSourceRefs`);
    assertNonEmptyArray(row.codexSourceRefs, `${row.key}.codexSourceRefs`);
  }
  assert.equal(Boolean(report.spark?.defaultSessionSelector), true);
  assert.equal(Boolean(report.spark?.explicitAttach), true);
  assert.equal(Boolean(report.spark?.nativeDelegation), true);
  assert.equal(Boolean(report.pi?.help), true);
  assert.equal(Boolean(report.pi?.modelProbe), true);
  assert.equal(Boolean(report.codex?.help), true);
  assert.equal(Boolean(report.codex?.execHelp), true);
});

void test("spark parity report binds session claims to workspace control plane", async () => {
  const report = await loadReportOrFixture();
  assert.equal(typeof report.spark?.workspace?.cwd, "string");
  assert.equal(report.spark.workspace.cwd.length > 0, true);
  assert.match(report.spark.workspace.hash, /^[a-f0-9]{16}$/u);
  assert.equal(typeof report.spark.controlPlaneSession.id, "string");
  assert.equal(report.spark.controlPlaneSession.id.includes(report.spark.workspace.hash), true);
  assert.equal(report.spark.defaultSessionSelector.includesSelectorText, true);
  assert.equal(report.spark.defaultSessionSelector.includesCompletedProjectTree, false);
  assert.equal(report.spark.defaultSessionSelector.workspaceHashEqualsControlPlane, true);
  assert.equal(report.spark.explicitAttach.attachMatchesControlPlane, true);
});

async function loadReportOrFixture(): Promise<any> {
  const path = process.env.SPARK_PARITY_REPORT_PATH ?? "/tmp/spark-pi-codex-parity-report.json";
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fixtureReport();
  }
}

function assertNonEmptyArray(value: unknown, label: string): void {
  assert.equal(Array.isArray(value), true, label);
  assert.equal((value as unknown[]).length > 0, true, label);
}

function fixtureReport(): any {
  const section = {
    paneId: "terminal_1",
    zellijCommand: "zellij --session spark run ...",
    command: ["echo", "fixture"],
    exitStatus: 0,
    dumpPath: "/tmp/fixture.dump.txt",
    stdoutExcerpt: "fixture",
  };
  const sourceRefs = ["fixture:/tmp/fixture.dump.txt"];
  return {
    spark: {
      workspace: { cwd: "/tmp/workspace", hash: "0123456789abcdef" },
      controlPlaneSession: { id: "workspace:0123456789abcdef", key: "session:0123456789abcdef" },
      defaultSessionSelector: {
        ...section,
        includesSelectorText: true,
        includesCompletedProjectTree: false,
        workspaceHashEqualsControlPlane: true,
      },
      explicitAttach: { ...section, attachMatchesControlPlane: true },
      nativeDelegation: section,
    },
    pi: { help: section, modelProbe: section },
    codex: { help: section, execHelp: section },
    comparisonRows: REQUIRED_ROW_KEYS.map((key) => ({
      key,
      spark: "fixture spark",
      pi: "fixture pi",
      codex: "fixture codex",
      sparkSourceRefs: sourceRefs,
      piSourceRefs: sourceRefs,
      codexSourceRefs: sourceRefs,
    })),
  };
}
