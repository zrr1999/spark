import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  cueContractHarnessExitCode,
  runSparkCueContractHarness,
} from "../scripts/spark-cue-contract-harness.mts";

test("cue contract harness reports a missing cued binary as a non-strict blocker", async () => {
  const temp = await mkdtemp(join(tmpdir(), "spark-cue-contract-unit-"));
  const outputPath = join(temp, "report.json");
  try {
    const report = await runSparkCueContractHarness({
      cuedBin: join(temp, "missing-cued"),
      outputPath,
      strict: false,
    });

    assert.equal(report.backend, "cue-contract");
    assert.equal(report.status, "blocked");
    assert.equal(report.paths.cuedBin, null);
    assert.match(report.blockers.join("\n"), /set CUED_BIN or CUE_SHELL_ROOT/u);
    assert.equal(cueContractHarnessExitCode(report, false), 0);
    assert.equal(cueContractHarnessExitCode(report, true), 1);

    const persisted = JSON.parse(await readFile(outputPath, "utf8")) as typeof report;
    assert.equal(persisted.status, "blocked");
    assert.deepEqual(persisted.blockers, report.blockers);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
