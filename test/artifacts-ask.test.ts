import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "spark-artifacts";
import { askUser, createAskUserRequest, createAskUserResult, defaultAskUserResult } from "pi-ask";
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

void test("ask_user clarification without UI defaults to the first available option", () => {
  const request = createAskUserRequest({
    title: "Ship it?",
    mode: "clarification",
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
  assert.equal(answer.status, "answered");
  assert.deepEqual(answer.answers.decision.values, ["yes"]);
});

void test("ask_user decision without UI blocks instead of implicitly approving", () => {
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
  assert.equal(answer.status, "no_selection");
  assert.equal(answer.nextAction, "block");
  assert.equal(answer.answers.decision, undefined);
});

void test("ask_user select options include a first-class custom affordance", async () => {
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
  const seenOptions: string[][] = [];
  const result = await askUser(request, {
    select: async (_title, options) => {
      seenOptions.push(options);
      return "My team";
    },
  });
  assert.deepEqual(seenOptions[0], ["Myself", "My team", "Type your own"]);
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers["target-user"], {
    values: ["team"],
    labels: ["My team"],
  });
});

void test("ask_user accepts custom text through the default custom affordance", async () => {
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
    select: async () => "Type your own",
    input: async () => "Language tooling engineers",
  });
  assert.equal(result.cancelled, false);
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers["target-user"], {
    values: [],
    labels: [],
    customText: "Language tooling engineers",
  });
});

void test("ask_user supports explicit selectWithCustom custom input metadata", async () => {
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
      },
    ],
  });
  const seen: Array<{ options: string[]; customLabel: string }> = [];
  const result = await askUser(request, {
    selectWithCustom: async (_title, input) => {
      seen.push(input);
      return { customText: "Language tooling engineers" };
    },
  });
  assert.deepEqual(seen[0], { options: ["Myself", "My team"], customLabel: "Type your own" });
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers["target-user"], {
    values: [],
    labels: [],
    customText: "Language tooling engineers",
  });
});

void test("ask_user supports single option selection", async () => {
  const request = createAskUserRequest({
    title: "Choose mode",
    mode: "clarification",
    questions: [
      {
        id: "mode",
        prompt: "Which mode?",
        type: "single",
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      },
    ],
  });
  const result = await askUser(request, { select: async () => "Safe" });
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers.mode, { values: ["safe"], labels: ["Safe"] });
});

void test("ask_user supports multi option and custom selections", async () => {
  const request = createAskUserRequest({
    title: "Choose workstreams",
    mode: "clarification",
    questions: [
      {
        id: "streams",
        prompt: "Which workstreams?",
        type: "multi",
        options: [
          { value: "docs", label: "Docs" },
          { value: "tests", label: "Tests" },
        ],
      },
    ],
  });
  const result = await askUser(request, { select: async () => "Docs, Research" });
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers.streams, {
    values: ["docs"],
    labels: ["Docs"],
    customText: "Research",
  });
});

void test("ask_user supports freeform questions as custom text answers", async () => {
  const request = createAskUserRequest({
    title: "Describe goal",
    mode: "clarification",
    questions: [
      {
        id: "goal",
        prompt: "What is the goal?",
        type: "freeform",
        required: true,
      },
    ],
  });
  const result = await askUser(request, { input: async () => "Make ask UX complete" });
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers.goal, {
    values: [],
    labels: [],
    customText: "Make ask UX complete",
  });
});

void test("ask_user required approval gates expose no-selection as blocking envelopes", async () => {
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

  const answered = await askUser(request, {
    select: () => new Promise((resolve) => setTimeout(() => resolve("Approve"), 20)),
  });
  assert.equal(answered.status, "answered");
  assert.equal(answered.nextAction, "resume");

  const noSelection = await askUser(request, { select: async () => undefined });
  assert.equal(noSelection.status, "no_selection");
  assert.equal(noSelection.cancelled, false);
  assert.equal(noSelection.nextAction, "block");
});

void test("ask_user approval gates preserve unmatched custom text as answered but blocked", async () => {
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
  const result = await askUser(request, { select: async () => "maybe later" });
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "block");
  assert.deepEqual(result.answers.decision, {
    values: [],
    labels: [],
    customText: "maybe later",
  });
});

void test("ask_user returns cancelled envelope without resuming", () => {
  const cancelled = createAskUserResult({ cancelled: true, answers: {} });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.nextAction, "block");
});
