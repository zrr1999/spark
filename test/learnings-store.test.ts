import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "spark-core";
import {
  defaultLearningStore,
  LearningExportFormatError,
  LearningStore,
  parseLegacyCompoundLearningMarkdown,
  parseLearningExportMarkdown,
  renderLearningExportMarkdown,
} from "spark-learnings";
import { contentHash, newRef } from "spark-core";

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

void test("learning store hydrates compacted artifact metadata for list and search", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-compacted-"));
  try {
    const store = new LearningStore({
      artifactStore: new ArtifactStore({ rootDir: dir, inlineBodyThresholdBytes: 64 }),
    });
    const recorded = await store.record({
      title: "Hydrate compacted learning metadata",
      statement: "Learning list/search should read full bodies when metadata keeps only previews.",
      category: "workflow",
      scope: "project",
      applicability: "x".repeat(200),
    });
    assert.equal(recorded.bodyTruncated, true);

    const listed = await store.list();
    assert.equal(listed[0]?.body.statement, recorded.body.statement);
    const results = await store.search({ query: "metadata previews" });
    assert.equal(results[0]?.ref, recorded.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("learning store rejects malformed persisted learning artifacts", async () => {
  const malformedDir = await mkdtemp(join(tmpdir(), "spark-learnings-malformed-"));
  const mismatchDir = await mkdtemp(join(tmpdir(), "spark-learnings-kind-mismatch-"));
  try {
    const malformedArtifactStore = new ArtifactStore({ rootDir: malformedDir });
    const malformedStore = new LearningStore({ artifactStore: malformedArtifactStore });
    await malformedArtifactStore.put({
      ref: newRef("artifact", "malformed-learning"),
      kind: "learning",
      title: "Malformed learning",
      format: "json",
      body: { status: "active" },
      provenance: { producer: "spark" },
    });
    await assert.rejects(
      () => malformedStore.list(),
      /invalid learning artifact artifact:malformed-learning: learning id must be a string/,
    );

    const mismatchArtifactStore = new ArtifactStore({ rootDir: mismatchDir });
    const mismatchStore = new LearningStore({ artifactStore: mismatchArtifactStore });
    const candidate = await mismatchStore.record({
      id: "candidate-kind-contract",
      title: "Candidate kind contract",
      statement: "Candidate learnings must stay in learning-candidate artifacts.",
      status: "candidate",
    });
    await mismatchArtifactStore.put({
      ref: newRef("artifact", "candidate-kind-mismatch"),
      kind: "learning",
      title: "Candidate kind mismatch",
      format: "json",
      body: candidate.body,
      provenance: { producer: "spark" },
    });
    await assert.rejects(
      () => mismatchStore.list({ includeCandidates: true }),
      /invalid learning artifact artifact:candidate-kind-mismatch: kind must be learning-candidate for candidate status/,
    );
  } finally {
    await rm(malformedDir, { recursive: true, force: true });
    await rm(mismatchDir, { recursive: true, force: true });
  }
});

void test("learning export markdown round-trips and rejects malformed blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-export-format-"));
  try {
    const store = new LearningStore({ artifactStore: new ArtifactStore({ rootDir: dir }) });
    const recorded = await store.record({
      id: "learning-export-format",
      title: "Learning export format is package-owned",
      statement: "Spark learning export Markdown must parse as validated LearningRecord objects.",
      category: "decision",
      scope: "project",
      tags: ["learning", "export"],
    });

    const markdown = renderLearningExportMarkdown([recorded.body]);
    assert.deepEqual(parseLearningExportMarkdown(markdown, "learnings.md"), [recorded.body]);

    assert.throws(
      () =>
        parseLearningExportMarkdown(
          ["# Invalid export", "", "```json spark-learning", "{not-json", "```", ""].join("\n"),
          "invalid-json.md",
        ),
      (error) =>
        error instanceof LearningExportFormatError &&
        error.filePath === "invalid-json.md" &&
        error.blockIndex === 1 &&
        /not valid JSON/.test(error.message),
    );

    assert.throws(
      () =>
        parseLearningExportMarkdown(
          [
            "# Invalid export",
            "",
            "```json spark-learning",
            JSON.stringify({ id: 42, title: "Incomplete record" }, null, 2),
            "```",
            "",
          ].join("\n"),
          "invalid-record.md",
        ),
      (error) =>
        error instanceof LearningExportFormatError &&
        error.filePath === "invalid-record.md" &&
        error.blockIndex === 1 &&
        /not valid learning record: learning id must be a string/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("legacy compound learning markdown parses as package-owned import input", () => {
  const markdown = `---
title: "Webhook 验证必须使用 raw body"
category: gotchas
tags: [stripe, webhook, python]
context: "集成 Stripe webhook 时验证始终失败"
---

## 问题

Stripe webhook 签名验证要求使用原始请求体（raw body）。
`;
  const input = parseLegacyCompoundLearningMarkdown({
    markdown,
    sourcePath: ".learnings/gotchas/stripe-webhook-raw-body.md",
    relativePath: "gotchas/stripe-webhook-raw-body.md",
  });

  assert.deepEqual(input, {
    title: "Webhook 验证必须使用 raw body",
    statement: "集成 Stripe webhook 时验证始终失败",
    category: "gotcha",
    scope: "project",
    status: "active",
    applicability: "集成 Stripe webhook 时验证始终失败",
    evidenceRefs: [".learnings/gotchas/stripe-webhook-raw-body.md"],
    sourcePaths: [".learnings/gotchas/stripe-webhook-raw-body.md"],
    sourceHash: contentHash(markdown),
    sourceContent: markdown,
    tags: ["stripe", "webhook", "python"],
    confidence: 0.8,
  });
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
