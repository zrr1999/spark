import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, Project } from "@zendev-lab/spark-extension-api";
import {
  defaultSparkProjectKindRegistry,
  evaluateSparkProjectKindCompletionGate,
  renderSparkProjectKindDisplay,
  sparkProjectKindRoleForPhase,
  createSparkProjectKindRegistry,
} from "../packages/spark-extension/src/extension/project-kind-registry.ts";

const baseProject: Project = {
  ref: "proj:demo",
  title: "Demo project",
  description: "Demo project",
  kind: "demo",
  kindState: {
    target: "CLI smoke",
    metrics: { done: 1, total: 2 },
    experiments: [{ status: "done" }, { status: "pending" }],
    findings: [{ title: "Finding A" }, { title: "Finding B" }],
  },
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

void test("project kind registry defaults generic to an empty declarative display", () => {
  const display = renderSparkProjectKindDisplay({ ...baseProject, kind: undefined });
  assert.deepEqual(display, { kind: "generic", title: "Generic", panels: [] });
});

void test("builtin reproduction kind declares display, phase plan, and gate", () => {
  const registry = defaultSparkProjectKindRegistry();
  const definition = registry.get("reproduction");
  assert.ok(definition);
  assert.equal(definition.display.badge, "repro");
  assert.deepEqual(definition.phasePlan, {
    research: "researcher",
    plan: "planner",
    implement: "engineer",
  });
  assert.match(definition.completionGate, /successMetrics_all_covered/);
  assert.equal(sparkProjectKindRoleForPhase({ kind: "reproduction" }, "implement"), "engineer");

  const kindState: JsonValue = {
    target: {
      sourceRefs: ["issue:1"],
      targetEnv: "local",
      expectedOutputs: ["CLI smoke passes"],
      successMetrics: [
        { id: "cli-smoke", status: "covered", covered: true },
        { id: "regression-note", status: "covered", covered: true },
      ],
    },
    experiments: [
      { id: "exp-pass", status: "passed", disposition: "not needed" },
      { id: "exp-fail", status: "failed", disposition: "documented as upstream" },
    ],
    findings: [{ title: "CLI smoke reproduced", learningRef: "artifact:learning-demo" }],
    learningRefs: ["artifact:learning-demo"],
  };
  const project: Project = {
    ...baseProject,
    kind: "reproduction",
    kindState,
  };

  const display = renderSparkProjectKindDisplay(project);
  assert.equal(display.kind, "reproduction");
  assert.equal(display.badge, "repro");
  assert.deepEqual(
    display.panels.map((panel) => ({ label: panel.label, render: panel.render, text: panel.text })),
    [
      { label: "Target", render: "text", text: JSON.stringify(kindState.target) },
      { label: "Metrics", render: "progress", text: "2/2" },
      { label: "Experiments", render: "counts", text: "2" },
      { label: "Findings", render: "list", text: "CLI smoke reproduced" },
    ],
  );
  assert.deepEqual(evaluateSparkProjectKindCompletionGate(project), {
    kind: "reproduction",
    gate: definition.completionGate,
    ok: true,
    summary:
      "reproduction gate satisfied: success metrics covered, failures dispositioned, learning recorded",
    blockers: [],
    details: {
      metrics: { done: 2, total: 2 },
      experiments: { total: 2, failedWithoutDisposition: 0 },
      findings: 1,
      learningRecorded: true,
    },
  });
});

void test("reproduction completion gate blocks uncovered metrics and missing learning", () => {
  const blocked = evaluateSparkProjectKindCompletionGate({
    ...baseProject,
    kind: "reproduction",
    kindState: {
      target: {
        successMetrics: [
          { id: "metric-a", status: "pending", covered: false },
          { id: "metric-b", status: "covered", covered: true },
        ],
      },
      experiments: [{ status: "failed", disposition: "" }],
      findings: [],
    },
  });

  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers, [
    "reproduction_success_metrics_uncovered=metric-a",
    "reproduction_failed_experiments_without_disposition=1",
    "reproduction_learning_not_recorded",
  ]);
});

void test("project kind display renders declarative text/progress/counts/list panels", () => {
  const registry = createSparkProjectKindRegistry([
    {
      id: "generic",
      title: "Generic",
      completionGate: "task_graph",
      phasePlan: {},
      display: { panels: [] },
    },
    {
      id: "demo",
      title: "Demo",
      completionGate: "demo_gate",
      phasePlan: { research: "researcher", plan: "planner", implement: "engineer" },
      stateSchema: "demo-v1",
      display: {
        badge: "demo",
        panels: [
          { label: "Target", source: "kindState.target", render: "text" },
          { label: "Metrics", source: "kindState.metrics", render: "progress" },
          { label: "Experiments", source: "kindState.experiments", render: "counts" },
          { label: "Findings", source: "kindState.findings", render: "list" },
        ],
      },
    },
  ]);

  const display = renderSparkProjectKindDisplay(baseProject, registry);

  assert.equal(display.kind, "demo");
  assert.equal(display.title, "Demo");
  assert.equal(display.badge, "demo");
  assert.deepEqual(
    display.panels.map((panel) => ({ label: panel.label, render: panel.render, text: panel.text })),
    [
      { label: "Target", render: "text", text: "CLI smoke" },
      { label: "Metrics", render: "progress", text: "1/2" },
      { label: "Experiments", render: "counts", text: "2" },
      { label: "Findings", render: "list", text: "Finding A, Finding B" },
    ],
  );
});
