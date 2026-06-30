import assert from "node:assert/strict";
import { mkdir, readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactStore,
  ArtifactStoreFormatError,
  defaultArtifactStore,
} from "@zendev-lab/pi-artifacts";
import { registerPiArtifactTool } from "@zendev-lab/pi-artifacts/extension";
import {
  AskConfigStoreFormatError,
  askUser,
  createAskArtifactBody,
  createAskConfigStore,
  createAskUserRequest,
  createAskUserResult,
  createPiAskFlowArtifactBody,
  defaultAskUserResult,
  getDefaultConfig,
  PiAskFlowPayloadStore,
  PiAskFlowPayloadStoreFormatError,
  registerPiAskActionTool,
  registerPiAskAutoAnswerProvider,
  registerPiAskFlowTool,
  registerPiAskTools,
  runPiAskFlow,
  summarizeAskResult,
  type PiAskUi,
  type StoredAskPayload,
} from "@zendev-lab/pi-ask";
import { newRef, type JsonValue } from "@zendev-lab/pi-extension-api";

void test("artifact store writes hashes, blobs, and lineage links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-core-artifacts-"));
  try {
    const store = new ArtifactStore({ rootDir: dir });
    const projectRef = newRef("proj", "demo-project");
    const first = await store.put({
      kind: "document",
      title: "Plan",
      format: "markdown",
      body: "# Plan\n",
      provenance: { producer: "spark", projectRef },
    });
    const second = await store.put({
      kind: "record",
      title: "Review",
      format: "json",
      body: { ok: true },
      provenance: {
        producer: "review",
        projectRef,
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
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
    assert.deepEqual(
      (await readdir(join(dir, "blobs"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact tool describes valid provenance producers", () => {
  const tools = new Map<string, { promptGuidelines?: string[]; parameters?: unknown }>();
  registerPiArtifactTool({ registerTool: (config) => tools.set(config.name, config) });
  const tool = tools.get("artifact");
  assert.ok(tool);

  const promptGuidelines = tool.promptGuidelines?.join("\n") ?? "";
  const parameters = JSON.stringify(tool.parameters);
  assert.match(promptGuidelines, /package-specific artifact aliases/);
  assert.doesNotMatch(promptGuidelines, /Spark-specific artifact aliases/);
  for (const text of [promptGuidelines, parameters]) {
    assert.match(text, /spark, role, task, review, ask, cue, user/);
    assert.match(text, /Do not use assistant/);
    assert.match(text, /Use producer=task with runRef\/taskRef for execution evidence/);
    assert.doesNotMatch(text, /role for child role-run output/);
    assert.doesNotMatch(text, /use producer=(?:spark|role)/i);
  }
  assert.match(parameters, /Role ref filter/);
});

void test("artifact record stores validation evidence as a producer-tagged record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifact-record-kind-"));
  try {
    const tools = new Map<
      string,
      { execute: Function; promptGuidelines?: string[]; parameters?: unknown }
    >();
    registerPiArtifactTool({ registerTool: (config) => tools.set(config.name, config) });
    const tool = tools.get("artifact");
    assert.ok(tool);
    const promptText = `${tool.promptGuidelines?.join("\n") ?? ""}\n${JSON.stringify(tool.parameters)}`;
    assert.match(promptText, /record \(structured JSON record/);

    const recorded = await tool.execute(
      "artifact-record-kind",
      {
        action: "record",
        kind: "record",
        title: "Targeted validation",
        format: "markdown",
        body: "`npm test -- --runInBand` passed.",
        provenance: { producer: "task" },
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    assert.equal(recorded.details.artifact.kind, "record");
    const listed = await defaultArtifactStore(dir).list({ producer: "task" });
    assert.deepEqual(
      listed.map((artifact) => artifact.ref),
      [recorded.details.refs.artifactRef],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact record rejects retired verification kind with a directed hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifact-retired-kind-"));
  try {
    const tools = new Map<string, { execute: Function }>();
    registerPiArtifactTool({ registerTool: (config) => tools.set(config.name, config) });
    const tool = tools.get("artifact");
    assert.ok(tool);
    await assert.rejects(
      tool.execute(
        "artifact-retired-kind",
        {
          action: "record",
          kind: "verification",
          title: "Targeted validation",
          format: "markdown",
          body: "passed",
          provenance: { producer: "task" },
        },
        new AbortController().signal,
        () => undefined,
        { cwd: dir },
      ),
      /kind=record/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact store maps known legacy artifact kinds when reading metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifact-legacy-kind-"));
  try {
    const store = new ArtifactStore({ rootDir: dir });
    const ref = newRef("artifact", "legacy-cue-output");
    const metadata = {
      ref,
      kind: "cue-output",
      title: "Cue output",
      format: "json",
      body: { ok: true },
      links: [],
      provenance: { producer: "cue" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      join(dir, `${ref.slice("artifact:".length)}.json`),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    const artifact = await store.get(ref);
    assert.equal(artifact.kind, "trace");
    assert.equal((artifact as unknown as { legacyKind?: string }).legacyKind, "cue-output");
    const [listed] = await store.list({ kind: "trace" });
    assert.equal(listed?.ref, ref);
    assert.equal(
      (listed as unknown as { legacyKind?: string } | undefined)?.legacyKind,
      "cue-output",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact store rejects unknown non-canonical artifact kinds when reading metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifact-noncanonical-kind-"));
  try {
    const ref = newRef("artifact", "noncanonical-unknown-kind");
    const metadata = {
      ref,
      kind: "unknown-artifact-kind",
      title: "Unknown kind",
      format: "markdown",
      body: "# Unknown\n",
      links: [],
      provenance: { producer: "spark" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      join(dir, `${ref.slice("artifact:".length)}.json`),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    const store = new ArtifactStore({ rootDir: dir });
    await assert.rejects(() => store.get(ref), /kind must be a valid artifact kind/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact record tool stores top-level refs as provenance shortcuts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifact-record-shortcuts-"));
  try {
    const tools = new Map<string, { execute: Function }>();
    registerPiArtifactTool({ registerTool: (config) => tools.set(config.name, config) });
    const tool = tools.get("artifact");
    assert.ok(tool);
    const projectRef = newRef("proj", "shortcut-project");
    const taskRef = newRef("task", "shortcut-task");

    const recorded = await tool.execute(
      "artifact-record-shortcuts",
      {
        action: "record",
        kind: "record",
        title: "Shortcut provenance",
        format: "markdown",
        body: "# Review\n",
        provenance: { producer: "review" },
        projectRef,
        taskRef,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    const recordedArtifactRef = recorded.details.refs.artifactRef as `artifact:${string}`;
    const recordedArtifact = await defaultArtifactStore(dir).get(recordedArtifactRef);
    assert.equal(recordedArtifact.provenance.projectRef, projectRef);
    assert.equal(recordedArtifact.provenance.taskRef, taskRef);

    const listed = await tool.execute(
      "artifact-list-shortcuts",
      { action: "list", projectRef, view: "summary" },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    assert.equal(listed.details.count, 1);
    assert.equal(listed.details.artifacts[0]?.projectRef, projectRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact record rejects conflicting top-level provenance shortcuts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifact-record-shortcut-conflict-"));
  try {
    const tools = new Map<string, { execute: Function }>();
    registerPiArtifactTool({ registerTool: (config) => tools.set(config.name, config) });
    const tool = tools.get("artifact");
    assert.ok(tool);

    await assert.rejects(
      () =>
        tool.execute(
          "artifact-record-shortcut-conflict",
          {
            action: "record",
            kind: "record",
            title: "Shortcut conflict",
            format: "markdown",
            body: "# Review\n",
            provenance: { producer: "review", projectRef: newRef("proj", "nested") },
            projectRef: newRef("proj", "top-level"),
          },
          new AbortController().signal,
          () => undefined,
          { cwd: dir },
        ),
      /projectRef conflicts with provenance\.projectRef/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact store compacts large metadata while hydrating full bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-core-artifacts-compact-"));
  try {
    const store = new ArtifactStore({
      rootDir: dir,
      inlineBodyThresholdBytes: 64,
      bodyPreviewChars: 16,
    });
    const body = { text: "abcdef".repeat(100) };
    const artifact = await store.put({
      kind: "document",
      title: "Large research",
      format: "json",
      body,
      provenance: { producer: "spark" },
    });

    const metadata = await readFile(store.pathFor(artifact.ref), "utf8");
    assert.match(metadata, /"bodyTruncated": true/);
    assert.doesNotMatch(metadata, /abcdefabcdefabcdefabcdefabcdef/);
    assert.deepEqual((await store.get<typeof body>(artifact.ref)).body, body);
    assert.equal(JSON.parse(await store.getBody(artifact.ref)).text, body.text);
    const [listed] = await store.list({ kind: "document" });
    assert.equal((listed as { bodyTruncated?: boolean } | undefined)?.bodyTruncated, true);

    const dryRun = await store.compactMetadata({ dryRun: true });
    assert.equal(dryRun.candidates.length, 0);
    assert.ok(dryRun.skipped.some((skip) => skip.reason === "already_compacted"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact store rejects malformed persisted metadata with file context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-core-artifacts-malformed-metadata-"));
  try {
    const store = new ArtifactStore({ rootDir: dir });
    const invalidPath = join(dir, "not-an-artifact.json");
    await writeFile(invalidPath, "[]\n", "utf8");

    await assert.rejects(
      () => store.list(),
      (error) =>
        error instanceof ArtifactStoreFormatError &&
        error.filePath === invalidPath &&
        error.reason === "invalid_metadata" &&
        /artifact metadata must be an object/.test(error.message),
    );
    const compacted = await store.compactMetadata();
    assert.equal(compacted.skipped[0]?.reason, "invalid_metadata");
    await rm(invalidPath, { force: true });

    const artifact = await store.put({
      kind: "document",
      title: "Broken metadata provenance",
      format: "json",
      body: { ok: true },
      provenance: { producer: "spark" },
    });
    const metadataPath = store.pathFor(artifact.ref);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    delete metadata.provenance;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => store.get(artifact.ref),
      (error) =>
        error instanceof ArtifactStoreFormatError &&
        error.filePath === metadataPath &&
        /provenance must be an object/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact store rejects invalid bodies before writing blobs or metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-core-artifacts-invalid-body-"));
  try {
    const store = new ArtifactStore({ rootDir: dir });
    const ref = newRef("artifact", "invalid-body");
    await assert.rejects(
      () =>
        store.put({
          ref,
          kind: "document",
          title: "Invalid body",
          format: "json",
          body: { ok: undefined } as unknown as JsonValue,
          provenance: { producer: "spark" },
        }),
      /body must be a JSON value/,
    );

    assert.deepEqual(await readdir(join(dir, "blobs")), []);
    await assert.rejects(() => readFile(store.pathFor(ref), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact metadata compaction dry-runs and rewrites legacy inline bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-core-artifacts-legacy-compact-"));
  try {
    const legacyStore = new ArtifactStore({
      rootDir: dir,
      inlineBodyThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    const compactingStore = new ArtifactStore({
      rootDir: dir,
      inlineBodyThresholdBytes: 64,
      bodyPreviewChars: 12,
    });
    const body = { text: "legacy-body-".repeat(100) };
    const artifact = await legacyStore.put({
      kind: "document",
      title: "Legacy large research",
      format: "json",
      body,
      provenance: { producer: "spark" },
    });
    const before = await readFile(legacyStore.pathFor(artifact.ref), "utf8");
    assert.match(before, /legacy-body-legacy-body-/);

    const dryRun = await compactingStore.compactMetadata({ dryRun: true });
    assert.equal(dryRun.compacted, 0);
    assert.equal(dryRun.candidates.length, 1);
    assert.ok(dryRun.reclaimableBytes > 0);
    assert.match(
      await readFile(legacyStore.pathFor(artifact.ref), "utf8"),
      /legacy-body-legacy-body-/,
    );

    const executed = await compactingStore.compactMetadata({ dryRun: false });
    assert.equal(executed.compacted, 1);
    const after = await readFile(legacyStore.pathFor(artifact.ref), "utf8");
    assert.match(after, /"bodyTruncated": true/);
    assert.doesNotMatch(after, /legacy-body-legacy-body-/);
    assert.deepEqual((await compactingStore.get<typeof body>(artifact.ref)).body, body);
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact store refuses metadata blob paths outside the artifact root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-core-artifacts-blob-boundary-"));
  try {
    const legacyStore = new ArtifactStore({
      rootDir: dir,
      inlineBodyThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    const compactingStore = new ArtifactStore({
      rootDir: dir,
      inlineBodyThresholdBytes: 64,
    });
    const artifact = await legacyStore.put({
      kind: "document",
      title: "External blob path",
      format: "text",
      body: "outside-boundary".repeat(100),
      provenance: { producer: "spark" },
    });
    const metadataPath = legacyStore.pathFor(artifact.ref);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { blobPath?: string };
    const outsidePath = `${dir}-outside.txt`;
    metadata.blobPath = outsidePath;
    await writeFile(outsidePath, "do not read or compact", "utf8");
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => legacyStore.getBody(artifact.ref),
      /artifact blob path escapes artifact store/,
    );
    const executed = await compactingStore.compactMetadata({ dryRun: false });

    assert.equal(executed.compacted, 0);
    assert.ok(executed.skipped.some((skip) => skip.reason === "invalid_blob_path"));
    assert.equal(await readFile(outsidePath, "utf8"), "do not read or compact");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-outside.txt`, { force: true });
  }
});

void test("ask flow payload store saves and loads the latest payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-payload-store-"));
  try {
    const store = new PiAskFlowPayloadStore();
    const payload = validAskFlowPayload();

    await store.save(dir, payload);

    assert.deepEqual(await store.load(dir), payload);
    assert.deepEqual(
      (await readdir(join(dir, ".pi", "asks"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("ask flow payload store rejects malformed persisted payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-payload-store-invalid-"));
  try {
    const store = new PiAskFlowPayloadStore();
    const filePath = join(dir, ".pi", "asks", "latest.json");

    assert.equal(await store.load(dir), null);
    await mkdir(join(dir, ".pi", "asks"), { recursive: true });

    await writeFile(filePath, "{not-json", "utf8");
    await assert.rejects(
      () => store.load(dir),
      (error) =>
        error instanceof PiAskFlowPayloadStoreFormatError &&
        error.filePath === filePath &&
        /not valid JSON/.test(error.message),
    );

    await writeFile(filePath, "[]\n", "utf8");
    await assert.rejects(
      () => store.load(dir),
      (error) =>
        error instanceof PiAskFlowPayloadStoreFormatError &&
        error.filePath === filePath &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(
      filePath,
      `${JSON.stringify({
        ...validAskFlowPayload(),
        request: { questions: {} },
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.load(dir),
      (error) =>
        error instanceof PiAskFlowPayloadStoreFormatError &&
        error.filePath === filePath &&
        /request\.questions must be an array/.test(error.message),
    );

    await writeFile(
      filePath,
      `${JSON.stringify({
        ...validAskFlowPayload(),
        request: { questions: [] },
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.load(dir),
      (error) =>
        error instanceof PiAskFlowPayloadStoreFormatError &&
        error.filePath === filePath &&
        /request is invalid: no_questions/.test(error.message),
    );

    await writeFile(
      filePath,
      `${JSON.stringify({
        ...validAskFlowPayload(),
        result: {
          ...validAskFlowPayload().result,
          answers: {
            decision: { questionId: "decision", kind: "option", values: [1] },
          },
        },
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.load(dir),
      (error) =>
        error instanceof PiAskFlowPayloadStoreFormatError &&
        error.filePath === filePath &&
        /result\.answers\.decision\.values must be a string array/.test(error.message),
    );

    await writeFile(
      filePath,
      `${JSON.stringify({ ...validAskFlowPayload(), timestamp: "now" })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.load(dir),
      (error) =>
        error instanceof PiAskFlowPayloadStoreFormatError &&
        error.filePath === filePath &&
        /timestamp must be a finite number/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("ask config store defaults only when the config file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-config-store-"));
  try {
    const filePath = join(dir, "pi-ask.json");
    const store = createAskConfigStore({ filePath });

    assert.deepEqual(store.load(), getDefaultConfig());
    store.save({ schemaVersion: 1 });

    assert.deepEqual(store.load(), { schemaVersion: 1 });
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("ask config store rejects malformed persisted config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-config-store-invalid-"));
  try {
    const filePath = join(dir, "pi-ask.json");
    const store = createAskConfigStore({ filePath });

    await writeFile(filePath, "{not-json", "utf8");
    assert.throws(
      () => store.load(),
      (error) =>
        error instanceof AskConfigStoreFormatError &&
        error.filePath === filePath &&
        /not valid JSON/.test(error.message),
    );

    await writeFile(filePath, "[]\n", "utf8");
    assert.throws(
      () => store.load(),
      (error) =>
        error instanceof AskConfigStoreFormatError &&
        error.filePath === filePath &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(filePath, "{}\n", "utf8");
    assert.deepEqual(store.load(), getDefaultConfig());

    await writeFile(filePath, `${JSON.stringify({ schemaVersion: "1" })}\n`, "utf8");
    assert.throws(
      () => store.load(),
      (error) =>
        error instanceof AskConfigStoreFormatError &&
        error.filePath === filePath &&
        /schemaVersion must be 1/.test(error.message),
    );

    assert.throws(
      () => store.save({ schemaVersion: 2 }),
      (error) =>
        error instanceof AskConfigStoreFormatError &&
        error.filePath === filePath &&
        /schemaVersion must be 1/.test(error.message),
    );
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

void test("ask_user plain select receives only business options", async () => {
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
  assert.deepEqual(seenOptions[0], ["Myself", "My team"]);
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers["target-user"], {
    values: ["team"],
    labels: ["My team"],
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

void test("ask_user and ask_flow share result summary and artifact body semantics", () => {
  const request = {
    title: "Choose mode",
    mode: "decision" as const,
    questions: [
      {
        id: "mode",
        prompt: "Which mode?",
        type: "single" as const,
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      },
    ],
  };
  const askUserResult = createAskUserResult({
    cancelled: false,
    answers: { mode: { values: ["safe"], labels: ["Safe"] } },
  });
  const flowResult = {
    status: "answered" as const,
    answers: {
      mode: { questionId: "mode", kind: "option" as const, values: ["safe"], labels: ["Safe"] },
    },
    flow: "test",
    mode: "submit" as const,
    cancelled: false,
    nextAction: "resume" as const,
  };

  assert.equal(summarizeAskResult(request, askUserResult), "Choose mode: answered; mode=Safe");
  assert.equal(summarizeAskResult(request, flowResult), "Choose mode: answered; mode=Safe");
  assert.deepEqual(
    createPiAskFlowArtifactBody(request, flowResult).summary,
    "Choose mode: answered; mode=Safe",
  );
  const artifactBody = createAskArtifactBody(
    { ...request, context: undefined },
    {
      ...flowResult,
      nextAction: undefined,
      answers: {
        mode: { ...flowResult.answers.mode, preview: undefined },
      },
    },
  );
  assert.equal("context" in artifactBody.request, false);
  assert.equal("nextAction" in artifactBody.result, false);
  assert.equal("preview" in artifactBody.result.answers.mode, false);
});

void test("ask_user tool summary uses option labels rather than raw ids", async () => {
  const tools = new Map<string, { execute: Function }>();
  registerPiAskTools({ registerTool: (config) => tools.set(config.name, config) });
  const tool = tools.get("ask_user");
  assert.ok(tool);

  const result = await tool.execute(
    "ask-user-test",
    {
      title: "Choose mode",
      mode: "clarification",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          options: [
            { value: "fast_mode", label: "Fast path" },
            { value: "safe_mode", label: "Safe path" },
          ],
        },
      ],
    },
    new AbortController().signal,
    () => undefined,
    { ui: { select: async () => "Safe path" } },
  );

  const text = result.content.map((part: { text: string }) => part.text).join("\n");
  assert.match(text, /mode=Safe path/);
  assert.doesNotMatch(text, /safe_mode/);
});

void test("ask_user uses protocol interaction before legacy select UI", async () => {
  let selectInvoked = false;
  let sawRequest: unknown;
  const result = await askUser(
    createAskUserRequest({
      title: "Choose mode",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          required: true,
          options: [
            { value: "fast_mode", label: "Fast path" },
            { value: "safe_mode", label: "Safe path" },
          ],
        },
      ],
    }),
    {
      interaction: async (request) => {
        sawRequest = request;
        return {
          kind: "askFlow",
          requestId: request.requestId,
          status: "answered",
          answers: { mode: { values: ["safe_mode"] } },
        };
      },
      select: async () => {
        selectInvoked = true;
        return "Fast path";
      },
    },
  );

  assert.equal(selectInvoked, false);
  assert.equal((sawRequest as { kind?: unknown }).kind, "askFlow");
  assert.equal((sawRequest as { source?: unknown }).source, "extension");
  assert.deepEqual(result.answers.mode, { values: ["safe_mode"], labels: ["Safe path"] });
  assert.equal(result.nextAction, "resume");
});

void test("ask_user falls back to legacy UI when protocol interaction is blocked", async () => {
  const result = await askUser(
    createAskUserRequest({
      title: "Choose mode",
      mode: "clarification",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          options: [
            { value: "fast_mode", label: "Fast path" },
            { value: "safe_mode", label: "Safe path" },
          ],
        },
      ],
    }),
    {
      interaction: async (request) => ({
        kind: "askFlow",
        requestId: request.requestId,
        status: "blocked",
        message: "headless host",
      }),
      select: async () => "Safe path",
    },
  );

  assert.deepEqual(result.answers.mode, { values: ["safe_mode"], labels: ["Safe path"] });
});

void test("ask_user preserves protocol cancellation as a blocking result", async () => {
  const result = await askUser(
    createAskUserRequest({
      title: "Choose mode",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          required: true,
          options: [
            { value: "fast_mode", label: "Fast path" },
            { value: "safe_mode", label: "Safe path" },
          ],
        },
      ],
    }),
    {
      interaction: async (request) => ({
        kind: "askFlow",
        requestId: request.requestId,
        status: "cancelled",
      }),
      select: async () => "Safe path",
    },
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.nextAction, "block");
  assert.deepEqual(result.answers, {});
});

void test("ask action tool dispatches canonical single-question asks", async () => {
  const tools = new Map<string, { execute: Function }>();
  const registerTool = (config: { name: string; execute: Function }) =>
    tools.set(config.name, config);
  registerPiAskTools({ registerTool });
  registerPiAskFlowTool({ registerTool });
  registerPiAskActionTool({ registerTool }, { resolveTool: (name) => tools.get(name) as never });
  const tool = tools.get("ask");
  assert.ok(tool);

  const result = await tool.execute(
    "ask-action-test",
    {
      action: "ask",
      title: "Choose mode",
      mode: "clarification",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          options: [
            { value: "fast_mode", label: "Fast path" },
            { value: "safe_mode", label: "Safe path" },
          ],
        },
      ],
    },
    new AbortController().signal,
    () => undefined,
    { ui: { select: async () => "Safe path" } },
  );

  const text = result.content.map((part: { text: string }) => part.text).join("\n");
  assert.match(text, /mode=Safe path/);
  assert.equal(result.details.request.questions.length, 1);
});

void test("ask action tool auto-answers with reviewer resolver without invoking UI", async () => {
  const tools = new Map<string, { execute: Function }>();
  const registerTool = (config: { name: string; execute: Function }) =>
    tools.set(config.name, config);
  registerPiAskTools({ registerTool });
  registerPiAskFlowTool({ registerTool });
  registerPiAskActionTool(
    { registerTool },
    {
      resolveTool: (name) => tools.get(name) as never,
      autoAnswer: async () => ({ answers: { mode: { values: ["safe_mode"] } } }),
    },
  );
  const tool = tools.get("ask");
  assert.ok(tool);
  let uiInvoked = false;

  const result = await tool.execute(
    "ask-auto-answer-test",
    {
      action: "ask",
      autoAnswer: "reviewer",
      title: "Choose mode",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          required: true,
          options: [
            { value: "fast_mode", label: "Fast path" },
            { value: "safe_mode", label: "Safe path" },
          ],
        },
      ],
    },
    new AbortController().signal,
    () => undefined,
    {
      ui: {
        select: async () => {
          uiInvoked = true;
          return "Fast path";
        },
      },
    },
  );

  assert.equal(uiInvoked, false);
  assert.equal(result.details.autoAnswered, true);
  assert.equal(result.details.result.status, "answered");
  assert.equal(result.details.result.nextAction, "resume");
  assert.deepEqual(result.details.result.answers.mode.values, ["safe_mode"]);
  assert.match(
    result.content.map((part: { text: string }) => part.text).join("\n"),
    /mode=Safe path/,
  );
});

void test("ask action tool reports missing reviewer resolver as a tool error with guidance", async () => {
  const tools = new Map<string, { execute: Function }>();
  const registerTool = (config: { name: string; execute: Function }) =>
    tools.set(config.name, config);
  registerPiAskTools({ registerTool });
  registerPiAskActionTool({ registerTool }, { resolveTool: (name) => tools.get(name) as never });
  const tool = tools.get("ask");
  assert.ok(tool);

  const result = await tool.execute(
    "ask-missing-auto-answer-resolver-test",
    {
      action: "ask",
      autoAnswer: "reviewer",
      title: "Choose mode",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          required: true,
          options: [{ value: "safe_mode", label: "Safe path" }],
        },
      ],
    },
    new AbortController().signal,
    () => undefined,
    {},
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.autoAnswered, false);
  assert.equal(result.details.blocked, true);
  assert.equal(result.details.result.nextAction, "block");
  assert.match(result.details.reason, /host-provided reviewer auto-answer resolver/);
  assert.match(result.details.reason, /active goal turns/);
  assert.match(result.details.reason, /omit autoAnswer=reviewer/);
  assert.match(result.content.map((part: { text: string }) => part.text).join("\n"), /blocked/i);
});

void test("ask action tool blocks empty reviewer answers for required questions", async () => {
  const tools = new Map<string, { execute: Function }>();
  const registerTool = (config: { name: string; execute: Function }) =>
    tools.set(config.name, config);
  registerPiAskTools({ registerTool });
  registerPiAskActionTool(
    { registerTool },
    {
      resolveTool: (name) => tools.get(name) as never,
      autoAnswer: async () => ({ reason: "reviewer omitted the answer", answers: {} }),
    },
  );
  const tool = tools.get("ask");
  assert.ok(tool);

  const result = await tool.execute(
    "ask-auto-answer-empty-required-test",
    {
      action: "ask",
      autoAnswer: "reviewer",
      title: "Choose mode",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          required: true,
          options: [{ value: "safe_mode", label: "Safe path" }],
        },
      ],
    },
    new AbortController().signal,
    () => undefined,
    {},
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.autoAnswered, false);
  assert.match(result.details.reason, /required question mode/);
});

void test("ask action tool can auto-answer through a registered provider", async () => {
  const tools = new Map<string, { execute: Function }>();
  const registerTool = (config: { name: string; execute: Function }) =>
    tools.set(config.name, config);
  registerPiAskTools({ registerTool });
  registerPiAskFlowTool({ registerTool });
  registerPiAskActionTool({ registerTool }, { resolveTool: (name) => tools.get(name) as never });
  const tool = tools.get("ask");
  assert.ok(tool);
  const unregister = registerPiAskAutoAnswerProvider("test-provider", async () => ({
    reason: "provider selected the safe path",
    answers: { mode: { values: ["safe_mode"] } },
  }));
  let uiInvoked = false;

  try {
    const result = await tool.execute(
      "ask-auto-answer-provider-test",
      {
        action: "ask",
        autoAnswer: "reviewer",
        title: "Choose mode",
        mode: "decision",
        questions: [
          {
            id: "mode",
            prompt: "Which mode?",
            type: "single",
            required: true,
            options: [
              { value: "fast_mode", label: "Fast path" },
              { value: "safe_mode", label: "Safe path" },
            ],
          },
        ],
      },
      new AbortController().signal,
      () => undefined,
      {
        ui: {
          select: async () => {
            uiInvoked = true;
            return "Fast path";
          },
        },
      },
    );

    assert.equal(uiInvoked, false);
    assert.equal(result.details.autoAnswered, true);
    assert.equal(result.details.autoAnswer.reason, "provider selected the safe path");
    assert.deepEqual(result.details.result.answers.mode.values, ["safe_mode"]);
  } finally {
    unregister();
  }
});

void test("ask action tool blocks invalid reviewer auto-answer output", async () => {
  const tools = new Map<string, { execute: Function }>();
  const registerTool = (config: { name: string; execute: Function }) =>
    tools.set(config.name, config);
  registerPiAskTools({ registerTool });
  registerPiAskActionTool(
    { registerTool },
    {
      resolveTool: (name) => tools.get(name) as never,
      autoAnswer: async () => ({ answers: { mode: { values: ["missing"] } } }),
    },
  );
  const tool = tools.get("ask");
  assert.ok(tool);

  const result = await tool.execute(
    "ask-auto-answer-invalid-test",
    {
      action: "ask",
      autoAnswer: "reviewer",
      title: "Choose mode",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which mode?",
          type: "single",
          required: true,
          options: [
            { value: "fast_mode", label: "Fast path" },
            { value: "safe_mode", label: "Safe path" },
          ],
        },
      ],
    },
    new AbortController().signal,
    () => undefined,
    {},
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.autoAnswered, false);
  assert.equal(result.details.blocked, true);
  assert.equal(result.details.result.nextAction, "block");
  assert.match(result.details.reason, /invalid option missing/);
  assert.match(result.content.map((part: { text: string }) => part.text).join("\n"), /blocked/i);
});

void test("ask_flow fullscreen requires explicit cwd for persisted payloads", async () => {
  const tools = new Map<string, { execute: Function }>();
  registerPiAskFlowTool({ registerTool: (config) => tools.set(config.name, config) });
  const tool = tools.get("ask_flow");
  assert.ok(tool);

  await assert.rejects(
    () =>
      tool.execute(
        "ask-flow-test",
        {
          title: "Choose mode",
          mode: "clarification",
          questions: [
            {
              id: "mode",
              prompt: "Which mode?",
              type: "single",
              options: [
                { value: "safe_mode", label: "Safe path" },
                { value: "fast_mode", label: "Fast path" },
              ],
            },
          ],
        },
        new AbortController().signal,
        () => undefined,
        { ui: { custom() {} } },
      ),
    /ask_flow fullscreen requires ctx\.cwd/,
  );
});

void test("ask_flow fullscreen passes a custom UI factory to Pi host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ask-flow-custom-factory-"));
  try {
    const tools = new Map<string, { execute: Function }>();
    registerPiAskFlowTool({ registerTool: (config) => tools.set(config.name, config) });
    const tool = tools.get("ask_flow");
    assert.ok(tool);

    let sawFactory = false;
    const result = await tool.execute(
      "ask-flow-custom-factory-test",
      {
        title: "Choose mode",
        mode: "clarification",
        questions: [
          {
            id: "mode",
            prompt: "Which mode?",
            type: "single",
            options: [
              { value: "safe_mode", label: "Safe path" },
              { value: "fast_mode", label: "Fast path" },
            ],
          },
        ],
      },
      new AbortController().signal,
      () => undefined,
      {
        cwd: dir,
        ui: {
          custom: async (...args: unknown[]) => {
            assert.equal(args.length, 1);
            assert.equal(typeof args[0], "function");
            sawFactory = true;
            const factory = args[0] as Function;
            const component = factory(
              { terminal: { columns: 120 }, requestRender() {} },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
                strikethrough: (text: string) => text,
                dim: (text: string) => text,
              },
              {},
              () => undefined,
            ) as { handleInput(data: string): void; render(width: number): string[] };
            assert.match(component.render(120).join("\n"), /Safe path/);
            component.handleInput("enter");
            component.handleInput("ctrl+s");
            component.handleInput("enter");
          },
        },
      },
    );

    assert.equal(sawFactory, true);
    assert.match(result.content.map((part: { text: string }) => part.text).join("\n"), /Safe path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("ask_flow fullscreen catches custom UI failures and returns a blocking fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ask-flow-custom-fallback-"));
  try {
    const tools = new Map<string, { execute: Function }>();
    registerPiAskFlowTool({ registerTool: (config) => tools.set(config.name, config) });
    const tool = tools.get("ask_flow");
    assert.ok(tool);

    const result = await tool.execute(
      "ask-flow-custom-fallback-test",
      {
        title: "Confirm scope",
        mode: "decision",
        questions: [
          {
            id: "scope",
            prompt: "Which scope?",
            type: "single",
            required: true,
            options: [
              { value: "safe", label: "Safe", description: "Use the safe scope." },
              { value: "broad", label: "Broad", description: "Use the broad scope." },
            ],
          },
        ],
      },
      new AbortController().signal,
      () => undefined,
      {
        cwd: dir,
        ui: {
          custom: async (...args: unknown[]) => {
            assert.equal(typeof args[0], "function");
            throw new TypeError("factory is not a function");
          },
        },
      },
    );

    assert.equal(result.details.status, "cancelled");
    assert.equal(result.details.cancelled, true);
    assert.equal(result.details.result.nextAction, "block");
    assert.match(result.details.customUiFallback, /factory is not a function/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("ask_user and ask_flow share UX result matrix semantics", async () => {
  type MatrixUi = Pick<PiAskUi, "select" | "input">;
  const cases: Array<{
    name: string;
    mode: "clarification" | "decision";
    type: "single" | "multi" | "freeform";
    required?: boolean;
    ui: MatrixUi;
    expected: { status: string; nextAction: string; values?: string[]; customText?: string };
  }> = [
    {
      name: "clarification single option resumes",
      mode: "clarification",
      type: "single",
      ui: { select: async () => "Safe" },
      expected: { status: "answered", nextAction: "resume", values: ["safe"] },
    },
    {
      name: "decision missing required selection blocks",
      mode: "decision",
      type: "single",
      required: true,
      ui: { select: async () => undefined },
      expected: { status: "no_selection", nextAction: "block" },
    },
    {
      name: "decision custom text is answered but blocked",
      mode: "decision",
      type: "single",
      required: true,
      ui: { select: async () => "Needs docs first" },
      expected: {
        status: "answered",
        nextAction: "block",
        values: [],
        customText: "Needs docs first",
      },
    },
    {
      name: "multi options preserve selected ids",
      mode: "clarification",
      type: "multi",
      ui: { select: async () => "Fast, Safe" },
      expected: { status: "answered", nextAction: "resume", values: ["fast", "safe"] },
    },
    {
      name: "freeform custom text resumes",
      mode: "clarification",
      type: "freeform",
      ui: { input: async () => "Write docs" },
      expected: { status: "answered", nextAction: "resume", values: [], customText: "Write docs" },
    },
  ];

  for (const matrixCase of cases) {
    const options =
      matrixCase.type === "freeform"
        ? undefined
        : [
            { value: "fast", label: "Fast" },
            { value: "safe", label: "Safe" },
          ];
    const askUserRequest = createAskUserRequest({
      title: matrixCase.name,
      mode: matrixCase.mode,
      questions: [
        {
          id: "answer",
          prompt: matrixCase.name,
          type: matrixCase.type,
          options,
          required: matrixCase.required,
        },
      ],
    });
    const flowRequest = {
      flow: matrixCase.name,
      title: matrixCase.name,
      mode: matrixCase.mode,
      questions: [
        {
          id: "answer",
          prompt: matrixCase.name,
          type: matrixCase.type,
          options,
          required: matrixCase.required,
        },
      ],
    };

    const askUserResult = await askUser(askUserRequest, matrixCase.ui);
    const flowResult = await runPiAskFlow(flowRequest, matrixCase.ui);
    assert.equal(askUserResult.status, matrixCase.expected.status, matrixCase.name);
    assert.equal(flowResult.status, matrixCase.expected.status, matrixCase.name);
    assert.equal(askUserResult.nextAction, matrixCase.expected.nextAction, matrixCase.name);
    assert.equal(flowResult.nextAction, matrixCase.expected.nextAction, matrixCase.name);
    assert.deepEqual(askUserResult.answers.answer?.values ?? [], matrixCase.expected.values ?? []);
    assert.deepEqual(flowResult.answers.answer?.values ?? [], matrixCase.expected.values ?? []);
    assert.equal(askUserResult.answers.answer?.customText, matrixCase.expected.customText);
    assert.equal(flowResult.answers.answer?.customText, matrixCase.expected.customText);
  }
});

void test("ask_user and ask_flow share option/custom parsing semantics", async () => {
  const options = [
    { value: "docs", label: "Docs" },
    { value: "tests", label: "Tests" },
  ];
  const askUserResult = await askUser(
    createAskUserRequest({
      title: "Choose workstreams",
      mode: "clarification",
      questions: [
        {
          id: "streams",
          prompt: "Which workstreams?",
          type: "multi",
          options,
        },
      ],
    }),
    { select: async () => "Docs, Research" },
  );
  const flowResult = await runPiAskFlow(
    {
      flow: "comparison",
      mode: "clarification",
      questions: [
        {
          id: "streams",
          prompt: "Which workstreams?",
          type: "multi",
          options,
        },
      ],
    },
    { select: async () => "Docs, Research" },
  );

  assert.deepEqual(askUserResult.answers.streams, {
    values: flowResult.answers.streams!.values,
    labels: flowResult.answers.streams!.labels ?? [],
    customText: flowResult.answers.streams!.customText,
    ...(flowResult.answers.streams!.preview !== undefined
      ? { preview: flowResult.answers.streams!.preview }
      : {}),
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

function validAskFlowPayload(): StoredAskPayload {
  return {
    request: {
      flow: "release-check",
      mode: "decision",
      title: "Ship this change?",
      questions: [
        {
          id: "decision",
          prompt: "Ship this change?",
          type: "single",
          required: true,
          options: [
            { value: "ship", label: "Ship", description: "Continue with the change." },
            { value: "hold", label: "Hold", description: "Pause before changing anything." },
          ],
        },
      ],
    },
    result: {
      flow: "release-check",
      status: "answered",
      mode: "submit",
      cancelled: false,
      nextAction: "resume",
      answers: {
        decision: {
          questionId: "decision",
          kind: "option",
          values: ["ship"],
          labels: ["Ship"],
        },
      },
    },
    timestamp: 123,
  };
}
