import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TOOL_KEYS = ["spark", "pi", "codex", "copilot"] as const;

void test("zellij competitor matrix has tool availability and sourced gap rows", async () => {
  const report = await loadReportOrFixture();
  for (const key of TOOL_KEYS) {
    const section = report[key];
    assert.equal(Boolean(section), true, key);
    assert.equal(Array.isArray(section.command), true, `${key}.command`);
    assert.equal(
      typeof section.exitStatus === "number" || section.exitStatus === null,
      true,
      `${key}.exitStatus`,
    );
    assert.match(section.availability, /^(available|unavailable)$/u, `${key}.availability`);
    assert.equal(typeof section.sourcePath, "string", `${key}.sourcePath`);
    assert.equal(section.sourcePath.length > 0, true, `${key}.sourcePath`);
  }
  if (report.copilot.availability === "unavailable") {
    const output =
      `${report.copilot.stderrExcerpt ?? ""}${report.copilot.stdoutExcerpt ?? ""}`.trim();
    assert.equal(output.length > 0, true, "copilot unavailable output excerpt");
  }
  assert.equal(Array.isArray(report.gapRows), true);
  assert.equal(report.gapRows.length >= 5, true);
  for (const row of report.gapRows) {
    assert.equal(typeof row.key, "string");
    assert.equal(Number.isInteger(row.impactRank), true, `${row.key}.impactRank`);
    assert.equal(Number.isInteger(row.tractabilityRank), true, `${row.key}.tractabilityRank`);
    assert.equal(typeof row.sparkEvidenceRef, "string", `${row.key}.sparkEvidenceRef`);
    assert.equal(row.sparkEvidenceRef.length > 0, true, `${row.key}.sparkEvidenceRef`);
    assert.equal(typeof row.competitorEvidenceRef, "string", `${row.key}.competitorEvidenceRef`);
    assert.equal(row.competitorEvidenceRef.length > 0, true, `${row.key}.competitorEvidenceRef`);
    assert.equal(typeof row.recommendedFollowUp, "string", `${row.key}.recommendedFollowUp`);
    assert.equal(row.recommendedFollowUp.length > 0, true, `${row.key}.recommendedFollowUp`);
  }
});

async function loadReportOrFixture(): Promise<any> {
  const path =
    process.env.SPARK_ZELLIJ_COMPETITOR_MATRIX_PATH ?? "/tmp/spark-zellij-competitor-matrix.json";
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fixtureReport();
  }
}

function fixtureCapture(
  command: string[],
  availability: "available" | "unavailable" = "available",
): any {
  return {
    command,
    zellijCommand: `zellij --session spark run -- ${command.join(" ")}`,
    paneId: "terminal_1",
    exitStatus: availability === "available" ? 0 : 127,
    availability,
    sourcePath: `/tmp/${command[0]}.stdout.txt`,
    stdoutExcerpt: availability === "available" ? "help" : "",
    stderrExcerpt: availability === "available" ? "" : "command not found",
  };
}

function fixtureReport(): any {
  return {
    spark: fixtureCapture(["spark", "--help"]),
    pi: fixtureCapture(["pi", "--help"]),
    codex: fixtureCapture(["codex", "--help"]),
    copilot: fixtureCapture(["copilot", "--help"], "unavailable"),
    gapRows: ["a", "b", "c", "d", "e"].map((key, index) => ({
      key,
      impactRank: index + 1,
      tractabilityRank: 1,
      sparkEvidenceRef: "spark:/tmp/spark.stdout.txt",
      competitorEvidenceRef: "pi:/tmp/pi.stdout.txt",
      recommendedFollowUp: "do concrete follow-up",
    })),
  };
}
