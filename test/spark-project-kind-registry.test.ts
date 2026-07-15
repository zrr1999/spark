import assert from "node:assert/strict";
import test from "node:test";

import type { Project } from "@zendev-lab/spark-extension-api";
import {
  evaluateSparkProjectKindCompletionGate,
  renderSparkProjectKindDisplay,
  sparkProjectKindRoleForPhase,
  normalizeProjectKindId,
} from "../packages/pi-extension/src/extension/project-kind-registry.ts";

const baseProject: Project = {
  ref: "proj:demo",
  title: "Demo project",
  description: "Demo project",
  kind: "reproduction",
  kindState: { target: "CLI smoke" },
  roadmap: {
    ref: "roadmap:demo",
    title: "Demo roadmap",
    items: [],
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  },
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
};

void test("normalizeProjectKindId returns generic for empty/null/undefined", () => {
  assert.equal(normalizeProjectKindId(undefined), "generic");
  assert.equal(normalizeProjectKindId(null), "generic");
  assert.equal(normalizeProjectKindId(""), "generic");
  assert.equal(normalizeProjectKindId("  "), "generic");
});

void test("normalizeProjectKindId passes through non-empty strings", () => {
  assert.equal(normalizeProjectKindId("reproduction"), "reproduction");
  assert.equal(normalizeProjectKindId("custom"), "custom");
});

void test("renderSparkProjectKindDisplay returns no-op display with no panels", () => {
  const display = renderSparkProjectKindDisplay(baseProject);
  assert.equal(display.kind, "reproduction");
  assert.deepEqual(display.panels, []);
  assert.equal(display.badge, undefined);
});

void test("renderSparkProjectKindDisplay returns generic for undefined kind", () => {
  const display = renderSparkProjectKindDisplay({ kind: undefined });
  assert.equal(display.kind, "generic");
  assert.deepEqual(display.panels, []);
});

void test("sparkProjectKindRoleForPhase always returns undefined (deprecated)", () => {
  assert.equal(sparkProjectKindRoleForPhase({ kind: "reproduction" }, "implement"), undefined);
  assert.equal(sparkProjectKindRoleForPhase({ kind: "generic" }, "plan"), undefined);
});

void test("evaluateSparkProjectKindCompletionGate always returns ok=true (deprecated)", () => {
  const result = evaluateSparkProjectKindCompletionGate(baseProject);
  assert.equal(result.ok, true);
  assert.equal(result.gate, "none");
  assert.deepEqual(result.blockers, []);
});

void test("evaluateSparkProjectKindCompletionGate ok even with empty kindState", () => {
  const result = evaluateSparkProjectKindCompletionGate({
    kind: "reproduction",
    kindState: undefined,
  });
  assert.equal(result.ok, true);
});
