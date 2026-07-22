import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultArtifactStore,
  defaultEvidenceStore,
  newArtifactRef,
  type EvidenceRef,
} from "./index.ts";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe("defaultEvidenceStore", () => {
  it("writes canonical evidence refs under .spark/evidence only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-evidence-store-"));
    workspaces.push(cwd);

    const entry = await defaultEvidenceStore(cwd).put({
      kind: "record",
      title: "Focused probe",
      format: "json",
      body: { summary: "probe passed" },
      provenance: { producer: "task" },
    });

    expect(entry.ref).toMatch(/^evidence:/u);
    expect(existsSync(defaultEvidenceStore(cwd).pathFor(entry.ref))).toBe(true);
    expect(existsSync(join(cwd, ".spark", "artifacts"))).toBe(false);
  });

  it("reads legacy internal records without preserving artifact identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-evidence-legacy-"));
    workspaces.push(cwd);
    const legacyRef = newArtifactRef("legacy-probe");
    await defaultArtifactStore(cwd).put({
      ref: legacyRef,
      kind: "record",
      title: "Legacy probe",
      format: "json",
      body: { summary: "legacy result" },
      provenance: { producer: "task" },
    });

    const migrated = await defaultEvidenceStore(cwd).get("evidence:legacy-probe" as EvidenceRef);
    expect(migrated.ref).toBe("evidence:legacy-probe");
  });
});
