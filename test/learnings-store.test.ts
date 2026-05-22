import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "spark-artifacts";
import { LearningStore, defaultLearningStore } from "spark-learnings";
import { newRef } from "spark-core";

void test("learning store records active learnings and searches by content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-"));
  try {
    const store = new LearningStore({ artifactStore: new ArtifactStore({ rootDir: dir }) });
    const evidenceRef = newRef("artifact", "evidence-plan");
    const recorded = await store.record({
      title: "Prefer explicit export for shared knowledge",
      statement: ".spark is local runtime state; shared learnings must be exported explicitly.",
      category: "decision",
      scope: "project",
      applicability: "When persisting Spark learning artifacts for a repository.",
      evidenceRefs: [evidenceRef],
      tags: ["nyakore", "spark"],
      confidence: 0.9,
    });

    assert.equal(recorded.kind, "learning");
    assert.equal(recorded.body.status, "active");
    assert.deepEqual(
      recorded.links.map((link) => link.to),
      [evidenceRef],
    );

    const results = await store.search({ query: "explicit export", scope: "project" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ref, recorded.ref);
    assert.match(results[0]?.snippet ?? "", /export/);
    assert.equal(results[0]?.evidenceSummary, evidenceRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("learning store keeps candidates out of default active recall", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-candidate-"));
  try {
    const store = new LearningStore({ artifactStore: new ArtifactStore({ rootDir: dir }) });
    const candidate = await store.record({
      title: "Candidate task lesson",
      statement: "Only promote task-derived lessons after review.",
      status: "candidate",
      tags: ["candidate"],
    });

    assert.equal(candidate.kind, "learning-candidate");
    assert.deepEqual(await store.search({ query: "task-derived" }), []);

    const candidateResults = await store.search({ query: "task-derived", includeCandidates: true });
    assert.deepEqual(
      candidateResults.map((result) => result.ref),
      [candidate.ref],
    );

    const active = await store.activate(candidate.ref);
    assert.equal(active.kind, "learning");
    assert.equal(active.body.status, "active");
    assert.equal((await store.search({ query: "task-derived" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("learning store supports stale, rejected, and superseded lifecycle states", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-lifecycle-"));
  try {
    const store = defaultLearningStore(dir);
    const oldLearning = await store.record({
      id: "learning-old-export-rule",
      title: "Old export rule",
      statement: "Commit local Spark state directly.",
      status: "active",
    });
    const replacement = await store.record({
      id: "learning-new-export-rule",
      title: "New export rule",
      statement: "Export Markdown explicitly before sharing Spark learning state.",
      status: "active",
      supersedes: [oldLearning.ref],
    });

    const superseded = await store.markSuperseded(
      oldLearning.ref,
      replacement.ref,
      "Replaced by explicit export policy.",
    );
    assert.equal(superseded.body.status, "superseded");
    assert.deepEqual(superseded.body.supersededBy, [replacement.ref]);
    assert.equal(superseded.body.staleReason, "Replaced by explicit export policy.");

    const stale = await store.markStale(replacement.ref, "Repository policy changed.");
    assert.equal(stale.body.status, "stale");
    assert.equal(stale.body.staleReason, "Repository policy changed.");
    assert.ok(stale.body.staleAt);

    const rejected = await store.record({
      id: "learning-rejected-candidate",
      title: "Rejected candidate",
      statement: "Unreviewed candidates should be active.",
      status: "candidate",
    });
    const rejectedUpdate = await store.rejectCandidate(
      rejected.ref,
      "Contradicts the decision gate.",
    );
    assert.equal(rejectedUpdate.kind, "learning-candidate");
    assert.equal(rejectedUpdate.body.status, "rejected");
    assert.equal(rejectedUpdate.body.rejectedReason, "Contradicts the decision gate.");

    assert.deepEqual(
      (await store.list({ includeInactive: true })).map((artifact) => artifact.body.status).sort(),
      ["rejected", "stale", "superseded"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
