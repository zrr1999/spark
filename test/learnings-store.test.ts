import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "@zendev-lab/spark-artifacts";
import {
  defaultLearningStore,
  LearningExportFormatError,
  LearningStore,
  parseLearningExportMarkdown,
  renderLearningExportMarkdown,
} from "@zendev-lab/spark-learnings";
import { newRef } from "@zendev-lab/spark-extension-api";

void test("learning store records active learnings and searches by content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-"));
  try {
    const store = new LearningStore({ artifactStore: new ArtifactStore({ rootDir: dir }) });
    const evidenceRef = newRef("artifact", "evidence-plan");
    const recorded = await store.record({
      title: "Prefer explicit export for shared knowledge",
      statement:
        "Spark learnings live in .learnings locally and can be shared through explicit exports.",
      category: "decision",
      applicability: "When persisting Spark learning artifacts for a repository.",
      evidenceRefs: [evidenceRef],
      tags: ["nyakore", "spark"],
      confidence: 0.9,
    });

    assert.equal(recorded.kind, "knowledge");
    assert.equal(recorded.body.status, "active");
    assert.equal(recorded.provenance.producer, "task");
    assert.match(recorded.provenance.note ?? "", /spark-learnings record/);
    assert.deepEqual(
      recorded.links.map((link) => link.to),
      [evidenceRef],
    );

    const results = await store.search({ query: "explicit export" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ref, recorded.ref);
    assert.match(results[0]?.snippet ?? "", /learning/);
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

void test("learning store skips malformed persisted learning artifacts with diagnostics", async () => {
  const malformedDir = await mkdtemp(join(tmpdir(), "spark-learnings-malformed-"));
  const mismatchDir = await mkdtemp(join(tmpdir(), "spark-learnings-kind-mismatch-"));
  try {
    const malformedArtifactStore = new ArtifactStore({ rootDir: malformedDir });
    const malformedStore = new LearningStore({ artifactStore: malformedArtifactStore });
    const valid = await malformedStore.record({
      id: "valid-learning-survives",
      title: "Valid learning survives",
      statement: "Learning list and search should keep valid records when neighbors are bad.",
      tags: ["resilient"],
    });
    await malformedArtifactStore.put({
      ref: newRef("artifact", "malformed-learning"),
      kind: "knowledge",
      title: "Malformed learning",
      format: "json",
      body: { status: "active" },
      provenance: { producer: "task" },
    });
    const invalidKindRef = newRef("artifact", "invalid-kind-learning");
    await writeFile(
      malformedArtifactStore.pathFor(invalidKindRef),
      JSON.stringify(
        {
          ref: invalidKindRef,
          kind: "not-a-valid-kind",
          title: "Invalid artifact kind",
          format: "json",
          body: {},
          links: [],
          provenance: { producer: "task" },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        null,
        2,
      ),
    );

    const listed = await malformedStore.listDetailed();
    assert.deepEqual(
      listed.artifacts.map((artifact) => artifact.ref),
      [valid.ref],
    );
    assert.equal(listed.diagnostics.length, 2);
    assert.match(
      listed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      /learning id must be a string/,
    );
    assert.match(
      listed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      /kind must be a valid artifact kind/,
    );

    const searched = await malformedStore.searchDetailed({ query: "valid records" });
    assert.deepEqual(
      searched.results.map((result) => result.ref),
      [valid.ref],
    );
    assert.equal(searched.diagnostics.length, 2);

    const mismatchArtifactStore = new ArtifactStore({ rootDir: mismatchDir });
    const mismatchStore = new LearningStore({ artifactStore: mismatchArtifactStore });
    const candidate = await mismatchStore.record({
      id: "candidate-kind-contract",
      title: "Candidate kind contract",
      statement: "Learning artifacts must stay in knowledge artifacts.",
      status: "candidate",
    });
    // A non-knowledge artifact in the same store is not a learning artifact: the
    // learning store filters by kind=knowledge and must ignore it, not warn or choke on it.
    await mismatchArtifactStore.put({
      ref: newRef("artifact", "unrelated-document"),
      kind: "document",
      title: "Unrelated document",
      format: "json",
      body: candidate.body,
      provenance: { producer: "task" },
    });
    const listedCandidates = await mismatchStore.listDetailed({ includeCandidates: true });
    assert.deepEqual(
      listedCandidates.artifacts.map((artifact) => artifact.ref),
      [candidate.ref],
    );
    assert.deepEqual(listedCandidates.diagnostics, []);
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
      statement: "Learning export Markdown must parse as validated LearningRecord objects.",
      category: "decision",
      tags: ["learning", "export"],
    });

    const markdown = renderLearningExportMarkdown([recorded.body]);
    assert.match(markdown, /```json pi-learning/);
    assert.doesNotMatch(markdown, /```json spark-learning/);
    assert.deepEqual(parseLearningExportMarkdown(markdown, "learnings.md"), [recorded.body]);
    assert.deepEqual(
      parseLearningExportMarkdown(
        markdown.replace("```json pi-learning", "```json spark-learning"),
        "legacy-learnings.md",
      ),
      [recorded.body],
    );

    assert.throws(
      () =>
        parseLearningExportMarkdown(
          ["# Invalid export", "", "```json pi-learning", "{not-json", "```", ""].join("\n"),
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
            "```json pi-learning",
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

    assert.equal(candidate.kind, "knowledge");
    assert.deepEqual(await store.search({ query: "task-derived" }), []);

    const candidateResults = await store.search({ query: "task-derived", includeCandidates: true });
    assert.deepEqual(
      candidateResults.map((result) => result.ref),
      [candidate.ref],
    );

    const active = await store.activate(candidate.ref);
    assert.equal(active.kind, "knowledge");
    assert.equal(active.body.status, "active");
    assert.equal((await store.search({ query: "task-derived" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("repository gitignore keeps local .learnings stores untracked", async () => {
  const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /^\.learnings\/$/m);
});

void test("default learning store writes to .learnings outside git workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-location-"));
  try {
    const store = defaultLearningStore(dir);
    assert.equal(store.location, "workspace");
    await store.record({
      id: "learning-location-path",
      title: "Location-derived learning store",
      statement: "Learning storage location is derived from the store path.",
    });
    assert.ok((await stat(join(dir, ".learnings", "learning-location-path.json"))).isFile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("default learning store treats git workspaces as repo learnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-repo-location-"));
  try {
    await mkdir(join(dir, ".git"));
    const store = defaultLearningStore(join(dir, "subdir"));
    assert.equal(store.location, "repo");
    await store.record({
      id: "learning-repo-location-path",
      title: "Repo learning store",
      statement: "Git workspace learnings are repo learnings.",
    });
    assert.ok((await stat(join(dir, ".learnings", "learning-repo-location-path.json"))).isFile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("default learning store uses child repo .learnings over parent workspace .learnings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "spark-learnings-parent-workspace-"));
  const repo = join(workspace, "child-repo");
  try {
    await mkdir(join(workspace, ".learnings"));
    await mkdir(join(repo, ".git"), { recursive: true });
    const store = defaultLearningStore(join(repo, "src"));
    assert.equal(store.location, "repo");
    await store.record({
      id: "learning-child-repo-location-path",
      title: "Child repo learning store",
      statement: "Nested Git repos use their own repo learning store.",
    });
    assert.ok(
      (await stat(join(repo, ".learnings", "learning-child-repo-location-path.json"))).isFile(),
    );
    await assert.rejects(
      stat(join(workspace, ".learnings", "learning-child-repo-location-path.json")),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

void test("default learning store writes user learnings under SPARK_HOME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-learnings-user-location-"));
  const previous = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const store = defaultLearningStore(dir, "user");
    assert.equal(store.location, "user");
    await store.record({
      id: "learning-user-location-path",
      title: "User learning store",
      statement: "User learnings live outside the repo/workspace.",
    });
    assert.ok((await stat(join(dir, "learnings", "learning-user-location-path.json"))).isFile());
  } finally {
    if (previous === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previous;
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
    assert.equal(rejectedUpdate.kind, "knowledge");
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
