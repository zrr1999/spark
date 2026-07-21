import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { defaultEvidenceStore, type ArtifactRef } from "@zendev-lab/spark-artifacts";
import {
  extractSparkCompactionCandidates,
  runSparkCompactionCandidatePipeline,
} from "@zendev-lab/spark-memory/compaction-candidates";
import { defaultRecallStore } from "@zendev-lab/spark-memory";
import sparkMemoryExtension from "../packages/spark-memory/src/extension.ts";
import type {
  SparkCompactionCandidatePipelineOptions,
  SparkCompactionCandidatePipelineResult,
} from "../packages/spark-memory/src/compaction-candidates.ts";
import type { ToolConfig } from "../packages/spark-core/src/index.ts";

const structuredSummary = {
  mode: "smart",
  structured: {
    preservedFacts: [
      "Package manager is pnpm.",
      "Validated durable delivery (evidence:delivery-proof).",
    ],
    decisions: ["Keep git as the original binary."],
    changedFiles: [
      {
        path: "packages/spark-memory/src/extension.ts",
        change: "wired post-compact candidates",
        evidenceRefs: ["artifact:changed-file-proof"],
      },
    ],
    unresolved: ["Run the final full gate."],
    inProgress: ["Document Compact V2."],
    failures: [
      {
        summary: "Daemon socket unavailable",
        cause: "process stopped",
        nextStep: "restart after build",
        evidenceRefs: ["evidence:daemon-proof"],
      },
    ],
    memoryRefs: ["evidence:unrelated-global-ref"],
  },
};

test("Smart compact extraction separates stable facts from open items and preserves direct evidence links", () => {
  const candidates = extractSparkCompactionCandidates(structuredSummary, {
    sessionId: "session:compact",
  });

  assert.equal(candidates.filter((candidate) => candidate.kind === "stable_fact").length, 4);
  assert.equal(candidates.filter((candidate) => candidate.kind === "open_item").length, 3);
  assert.deepEqual(
    candidates.find((candidate) => candidate.text === "Package manager is pnpm.")?.evidenceRefs,
    [],
  );
  assert.deepEqual(
    candidates.find((candidate) => candidate.text.includes("Validated durable delivery"))
      ?.evidenceRefs,
    ["evidence:delivery-proof"],
  );
  assert.deepEqual(
    candidates.find((candidate) => candidate.text.startsWith("packages/spark-memory"))
      ?.evidenceRefs,
    ["artifact:changed-file-proof"],
  );
  assert.ok(candidates.every((candidate) => candidate.sourceSessionId === "session:compact"));
});

test("post-compact pipeline persists candidates but writes Memory only with resolvable evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-compact-candidates-"));
  try {
    await defaultEvidenceStore(dir).put({
      ref: "evidence:delivery-proof" as ArtifactRef,
      kind: "record",
      title: "Delivery validation",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
    const written: Array<{ text: string; evidenceRefs?: string[] }> = [];
    const memories: Array<{
      id: string;
      scope: "workspace";
      category: "insight";
      text: string;
      reason: string;
      evidenceRefs: string[];
      tags: string[];
      status: "active";
      createdAt: string;
      updatedAt: string;
    }> = [];
    const result = await runSparkCompactionCandidatePipeline({
      cwd: dir,
      sessionId: "session:compact",
      summary: "rendered summary",
      details: structuredSummary,
      memoryStore: {
        async list() {
          return memories;
        },
        async remember(input) {
          written.push({ text: input.text, evidenceRefs: input.evidenceRefs });
          const memory = {
            id: `memory:${written.length}`,
            scope: "workspace" as const,
            category: "insight" as const,
            text: input.text,
            reason: input.reason,
            evidenceRefs: input.evidenceRefs ?? [],
            tags: input.tags ?? [],
            status: "active" as const,
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:00:00.000Z",
          };
          memories.push(memory);
          return memory;
        },
      },
    });

    assert.equal(result.candidates.length, 7);
    assert.equal(result.writtenMemory.length, 1);
    assert.equal(result.rejectedForEvidence, 3);
    assert.deepEqual(written, [
      {
        text: "Validated durable delivery (evidence:delivery-proof).",
        evidenceRefs: ["evidence:delivery-proof"],
      },
    ]);
    const replay = await runSparkCompactionCandidatePipeline({
      cwd: dir,
      sessionId: "session:compact",
      summary: "rendered summary",
      details: structuredSummary,
    });
    assert.equal(replay.candidates.length, 7);
    const stored = await defaultRecallStore(dir, "workspace").list();
    assert.equal(stored.length, 7);
    assert.equal(stored.filter((candidate) => candidate.kind === "open_item").length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate review and Memory write failures are isolated from remaining candidates", async () => {
  let reviewCount = 0;
  const result = await runSparkCompactionCandidatePipeline({
    cwd: "/unused",
    summary: "rendered summary",
    details: {
      structured: {
        changedFiles: [
          { path: "a.ts", change: "first", evidenceRefs: ["evidence:first"] },
          { path: "b.ts", change: "second", evidenceRefs: ["evidence:second"] },
        ],
      },
    },
    candidateStore: new InMemoryCandidateStore(),
    evidenceStore: {
      async tryGet() {
        return {} as never;
      },
    },
    async reviewCandidate() {
      reviewCount += 1;
      if (reviewCount === 1) throw new Error("review unavailable");
      return "accept";
    },
    memoryStore: {
      async list() {
        return [];
      },
      async remember() {
        throw new Error("memory unavailable");
      },
    },
  });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.writtenMemory.length, 0);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0] ?? "", /review unavailable/);
  assert.match(result.failures[1] ?? "", /memory unavailable/);
});

test("session_compact schedules candidate work after returning and ignores failed or non-full events", async () => {
  const api = new FakeApi();
  let releasePipeline: (() => void) | undefined;
  const pipelineStarted = new Promise<void>((resolve) => {
    api.runPipeline = async () => {
      resolve();
      await new Promise<void>((release) => {
        releasePipeline = release;
      });
      return emptyPipelineResult();
    };
  });
  sparkMemoryExtension(api, {
    runCompactionCandidatePipeline: (options) => api.runPipeline(options),
  });
  const handler = api.handlers.get("session_compact");
  assert.ok(handler);

  const returned = handler(
    {
      compactType: "full",
      succeeded: true,
      sessionId: "session:compact",
      compactionEntry: {
        type: "compaction",
        summary: "Smart summary",
        details: structuredSummary,
      },
    },
    { cwd: "/workspace" },
  );
  assert.equal(returned, undefined);
  await pipelineStarted;
  assert.ok(releasePipeline, "background pipeline should be running after handler returns");
  releasePipeline();

  let calls = 0;
  api.runPipeline = async () => {
    calls += 1;
    return emptyPipelineResult();
  };
  handler({ compactType: "micro", succeeded: true, compactionEntry: {} }, { cwd: "/workspace" });
  handler({ compactType: "full", succeeded: false, compactionEntry: {} }, { cwd: "/workspace" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
});

class InMemoryCandidateStore {
  readonly candidates: Awaited<ReturnType<ReturnType<typeof defaultRecallStore>["list"]>> = [];

  async list() {
    return this.candidates;
  }

  async record(input: Parameters<ReturnType<typeof defaultRecallStore>["record"]>[0]) {
    const now = "2026-07-21T00:00:00.000Z";
    const candidate = {
      id: `recall:${this.candidates.length + 1}`,
      scope: input.scope,
      text: input.text,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs ?? [],
      kind: input.kind ?? "explicit",
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      status: "candidate" as const,
      createdAt: now,
      updatedAt: now,
    };
    this.candidates.push(candidate);
    return candidate;
  }
}

class FakeApi {
  readonly handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  readonly tools = new Map<string, ToolConfig>();
  runPipeline: (
    options: SparkCompactionCandidatePipelineOptions,
  ) => Promise<SparkCompactionCandidatePipelineResult> = async () => emptyPipelineResult();

  registerTool(config: ToolConfig): void {
    this.tools.set(config.name, config);
  }

  getAllTools(): Array<{ name: string }> {
    return Array.from(this.tools.keys()).map((name) => ({ name }));
  }

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    this.handlers.set(event, handler);
  }

  sendMessage(): void {}
}

function emptyPipelineResult(): SparkCompactionCandidatePipelineResult {
  return { candidates: [], writtenMemory: [], rejectedForEvidence: 0, failures: [] };
}
