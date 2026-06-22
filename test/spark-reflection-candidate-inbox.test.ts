import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  candidateFromObservation,
  dispositionReflectionCandidate,
  emptyReflectionCandidateStore,
  listReflectionCandidates,
  loadReflectionCandidateStore,
  readReflectionCandidate,
  reflectionCandidateStorePath,
  renderReflectionCandidateReport,
  saveReflectionCandidateStore,
  upsertReflectionCandidates,
} from "../packages/spark-extension/src/extension/reflection-candidate-inbox.ts";
import type { ReflectionObservation } from "../packages/spark-extension/src/extension/reflection-session-scanner.ts";

void test("reflection candidate inbox creates bounded report-only candidates and dedupes repeats", () => {
  const now = "2026-06-18T01:00:00.000Z";
  const observations: ReflectionObservation[] = [
    observation("u1", "TODO: fix follow-up scanner cursor", ["todo_like", "task_intent"]),
    observation("u2", "blocked by reviewer timeout; remaining validation work is unfinished", [
      "blocker",
      "unfinished_intent",
    ]),
    observation(
      "c1",
      "Spark context: Unfinished tasks: candidate inbox",
      ["unfinished_intent", "task_intent"],
      "custom_message",
    ),
    observation(
      "harness",
      "Return ONLY one valid JSON object. Instruction: Review this Spark state transition request.",
      ["blocker", "task_intent"],
    ),
  ];

  const first = upsertReflectionCandidates(emptyReflectionCandidateStore(now), observations, {
    now,
  });
  assert.equal(first.created.length, 3);
  assert.equal(first.skipped, 1);
  assert.equal(first.store.candidates.length, 3);

  const second = upsertReflectionCandidates(first.store, observations, {
    now: "2026-06-18T01:01:00.000Z",
  });
  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 3);
  assert.equal(second.store.candidates.length, 3);
  assert.ok(second.store.candidates.every((candidate) => candidate.occurrenceCount === 2));

  const [candidate] = listReflectionCandidates(second.store);
  assert.ok(candidate);
  assert.equal(readReflectionCandidate(second.store, candidate.id)?.id, candidate.id);
  const ignored = dispositionReflectionCandidate(second.store, {
    id: candidate.id,
    status: "ignored",
    note: "not actionable after review",
    now: "2026-06-18T01:02:00.000Z",
  });
  assert.equal(readReflectionCandidate(ignored, candidate.id)?.status, "ignored");
  assert.equal(listReflectionCandidates(ignored).length, 2);
  assert.match(
    renderReflectionCandidateReport(ignored, { status: "all" }),
    /Reflection candidate inbox/,
  );
  assert.match(
    renderReflectionCandidateReport(ignored, { status: "all" }),
    /suggested next action/,
  );
});

void test("reflection candidate store persists and reloads without task graph mutation APIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reflection-candidates-"));
  try {
    const path = reflectionCandidateStorePath(dir);
    const candidate = candidateFromObservation(
      observation("u1", "后续补上 candidate inbox report", ["todo_like", "task_intent"]),
      "2026-06-18T01:00:00.000Z",
    );
    assert.ok(candidate);
    await saveReflectionCandidateStore(path, {
      ...emptyReflectionCandidateStore(),
      candidates: [candidate],
    });
    const loaded = await loadReflectionCandidateStore(path);
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.candidates[0]?.id, candidate.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function observation(
  entryId: string,
  text: string,
  signals: ReflectionObservation["signals"],
  kind: ReflectionObservation["kind"] = "user_prompt",
): ReflectionObservation {
  return {
    id: `obs-${entryId}`,
    kind,
    source: {
      file: `/tmp/session-${entryId}.jsonl`,
      line: 4,
      entryId,
      parentId: null,
      timestamp: "2026-06-18T00:00:00.000Z",
      sessionId: "session-one",
      cwd: "/repo",
      customType: kind === "custom_message" ? "spark-mode-context" : undefined,
    },
    text,
    excerpt: text,
    signals,
  };
}
