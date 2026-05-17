import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "spark-artifacts";
import { askUser, createAskUserRequest, defaultAskUserResult } from "pi-ask";
import { newRef } from "spark-core";

void test("artifact store writes hashes, blobs, and lineage links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifacts-"));
  try {
    const store = new ArtifactStore({ rootDir: dir });
    const threadRef = newRef("thread", "demo-thread");
    const first = await store.put({
      kind: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan\n",
      provenance: { producer: "spark", threadRef },
    });
    const second = await store.put({
      kind: "review",
      title: "Review",
      format: "json",
      body: { ok: true },
      provenance: {
        producer: "review",
        threadRef,
        parentArtifactRefs: [first.ref],
      },
    });

    assert.ok(first.hash);
    assert.equal(await store.getBody(first.ref), "# Plan\n");
    assert.deepEqual(
      (await store.list({ linkedTo: first.ref })).map((artifact) => artifact.ref),
      [second.ref],
    );
    assert.equal((await store.diff(first.ref, second.ref)).same, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("ask_user defaults to the first available option", () => {
  const request = createAskUserRequest({
    title: "Ship it?",
    mode: "approval",
    questions: [
      {
        id: "decision",
        prompt: "Ship it?",
        type: "single",
        options: [
          { value: "yes", label: "Approve" },
          { value: "no", label: "Do not approve" },
        ],
        required: true,
      },
    ],
  });
  const answer = defaultAskUserResult(request);
  assert.deepEqual(answer.answers.decision.values, ["yes"]);
});

void test("ask_user accepts direct custom input without an explicit other option", async () => {
  const request = createAskUserRequest({
    title: "Audience",
    questions: [
      {
        id: "target-user",
        prompt: "Who is this for?",
        type: "single",
        options: [
          { value: "self", label: "Myself" },
          { value: "team", label: "My team" },
        ],
        required: true,
      },
    ],
  });
  const result = await askUser(request, {
    select: async () => "Language tooling engineers",
  });
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.answers["target-user"], {
    values: [],
    labels: [],
    customText: "Language tooling engineers",
  });
});
