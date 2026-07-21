import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ArtifactStore } from "@zendev-lab/spark-artifacts";
import type { JsonValue, RoleRef, RunRef, TaskRef, ProjectRef } from "@zendev-lab/spark-core";
import {
  collectRoleRunArtifactRetentionPlan,
  isRoleRunArtifactBody,
  readRoleRunArtifactPreview,
} from "@zendev-lab/spark-runtime";

test("runtime role-run artifact body guard owns compact artifact shape", () => {
  const valid = {
    schemaVersion: 1,
    runRef: "run:guard" as RunRef,
    taskRef: "task:guard" as TaskRef,
    roleRef: "role:builtin-worker" as RoleRef,
    status: "succeeded",
    summary: "guarded body",
    record: {
      ref: "run:guard" as RunRef,
      roleRef: "role:builtin-worker" as RoleRef,
      status: "succeeded",
    },
    stdout: { bytes: 12, tail: "stdout", tailBytes: 6, truncated: false },
    stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
    jsonEvents: { count: 1, tail: ['{"type":"done"}'], tailEventCount: 1, truncated: false },
  };

  assert.equal(isRoleRunArtifactBody(valid), true);
  assert.equal(
    isRoleRunArtifactBody({ ...valid, jsonEvents: { ...valid.jsonEvents, tail: [{}] } }),
    false,
  );
  assert.equal(
    isRoleRunArtifactBody({ ...valid, stdout: { ...valid.stdout, tailBytes: "6" } }),
    false,
  );
});

test("runtime role-run artifact preview owns bounded metadata reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-runtime-role-run-preview-"));
  try {
    const store = new ArtifactStore({ rootDir: join(dir, ".spark", "artifacts") });
    const roleRef = "role:builtin-worker" as RoleRef;
    const runRef = "run:preview" as RunRef;
    const taskRef = "task:preview" as TaskRef;
    const artifact = await store.put({
      kind: "trace",
      title: "Previewable role run",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef,
        taskRef,
        roleRef,
        status: "failed",
        summary: "Preview summary",
        record: { ref: runRef, roleRef, status: "failed" },
        stdout: { bytes: 12, tail: "stdout-tail", tailBytes: 11, truncated: false },
        stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
        jsonEvents: { count: 1, tail: ['{"type":"error"}'], tailEventCount: 1, truncated: false },
      } as JsonValue,
      provenance: { producer: "task", taskRef, roleRef, runRef },
    });

    const preview = await readRoleRunArtifactPreview(dir, artifact.ref);
    assert.equal(preview.summary, "Preview summary");
    assert.equal(preview.status, "failed");
    assert.equal(preview.stdout?.tail, "stdout-tail");
    assert.equal(preview.jsonEvents?.count, 1);

    const tooLarge = await readRoleRunArtifactPreview(dir, artifact.ref, { maxMetadataBytes: 1 });
    assert.match(tooLarge.skippedReason ?? "", /metadata_too_large/);

    const nonRoleRun = await store.put({
      kind: "document",
      title: "Research artifact",
      format: "text",
      body: "not a role-run",
      provenance: { producer: "spark" },
    });
    const skipped = await readRoleRunArtifactPreview(dir, nonRoleRun.ref);
    assert.match(skipped.skippedReason ?? "", /not_role_run_artifact: document/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime role-run retention ignores legacy agent-run artifact kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-runtime-agent-run-retention-"));
  try {
    const artifactRoot = join(dir, ".spark", "artifacts");
    const blobDir = join(artifactRoot, "blobs");
    await mkdir(blobDir, { recursive: true });
    await writeFile(join(blobDir, "legacy-agent-run.txt"), "x".repeat(2048), "utf8");
    await writeFile(
      join(artifactRoot, "legacy-agent-run.json"),
      `${JSON.stringify(
        {
          ref: "artifact:legacy-agent-run",
          kind: "agent-run",
          title: "Legacy agent run",
          format: "text",
          bodySize: 2048,
          blobPath: "blobs/legacy-agent-run.txt",
          provenance: { producer: "task" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const plan = await collectRoleRunArtifactRetentionPlan(dir, {
      dryRun: true,
      thresholdBytes: 1,
      tailBytes: 64,
    });

    assert.equal(plan.candidates.length, 0);
    const skipped = plan.skipped.find((item) => item.ref === "artifact:legacy-agent-run");
    assert.equal(skipped?.kind, "agent-run");
    assert.equal(skipped?.reason, "not_role_run_artifact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime role-run retention compacts historical transcript blobs without extension state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-runtime-role-run-retention-"));
  try {
    const store = new ArtifactStore({
      rootDir: join(dir, ".spark", "artifacts"),
      inlineBodyThresholdBytes: 512,
    });
    const body = {
      schemaVersion: 1,
      runRef: "run:runtime-retention" as RunRef,
      taskRef: "task:runtime-retention" as TaskRef,
      roleRef: "role:builtin-worker" as RoleRef,
      runName: "runtime-retention-worker",
      status: "succeeded",
      summary: "large historical role-run output",
      record: {
        ref: "run:runtime-retention" as RunRef,
        roleRef: "role:builtin-worker" as RoleRef,
        runName: "runtime-retention-worker",
        status: "succeeded",
      },
      stdout: {
        bytes: 4096,
        tail: "tail-marker",
        tailBytes: "tail-marker".length,
        truncated: true,
      },
      stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
      jsonEvents: { count: 0, tail: [], tailEventCount: 0, truncated: false },
      payload: `${"x".repeat(4096)}tail-marker`,
    };
    const artifact = await store.put({
      kind: "trace",
      title: "Large runtime role run",
      format: "json",
      body: body as unknown as JsonValue,
      provenance: {
        producer: "task",
        projectRef: "proj:runtime-retention" as ProjectRef,
        taskRef: "task:runtime-retention" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
        runRef: "run:runtime-retention" as RunRef,
      },
    });
    const before = JSON.parse(await readFile(store.pathFor(artifact.ref), "utf8")) as {
      blobPath: string;
    };
    const blobPath = join(dir, ".spark", "artifacts", before.blobPath);
    assert.equal(existsSync(blobPath), true);

    const dryRun = await collectRoleRunArtifactRetentionPlan(dir, {
      dryRun: true,
      thresholdBytes: 1024,
      tailBytes: 96,
      exportDir: "exports/role-run-transcripts",
    });
    assert.equal(dryRun.candidates.length, 1);
    assert.equal(dryRun.deleted.length, 0);
    assert.equal(dryRun.candidates[0]?.runName, "runtime-retention-worker");
    assert.match(dryRun.candidates[0]?.transcriptTail?.tail ?? "", /tail-marker/);
    assert.equal(existsSync(blobPath), true);

    const applied = await collectRoleRunArtifactRetentionPlan(dir, {
      dryRun: false,
      thresholdBytes: 1024,
      tailBytes: 96,
      exportDir: "exports/role-run-transcripts",
    });
    assert.equal(applied.candidates.length, 1);
    assert.equal(applied.deleted.length, 1);
    assert.equal(existsSync(blobPath), false);

    const after = JSON.parse(await readFile(store.pathFor(artifact.ref), "utf8")) as {
      body: { summary: string; stdout: { tail: string } };
      bodyTruncated?: boolean;
      blobPath?: string;
      transcriptRetention?: { exportPath?: string; fullTranscriptDeletedAt?: string };
    };
    assert.equal(after.blobPath, undefined);
    assert.equal(after.bodyTruncated, false);
    assert.match(after.body.summary, /runtime-retention-worker/);
    assert.match(after.body.stdout.tail, /tail-marker/);
    assert.ok(after.transcriptRetention?.fullTranscriptDeletedAt);
    assert.ok(after.transcriptRetention?.exportPath);
    assert.equal(existsSync(join(dir, after.transcriptRetention.exportPath)), true);

    const secondPass = await collectRoleRunArtifactRetentionPlan(dir, {
      dryRun: true,
      thresholdBytes: 1024,
      tailBytes: 96,
    });
    assert.equal(secondPass.candidates.length, 0);
    assert.ok(secondPass.skipped.some((item) => item.reason === "already_retained"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
