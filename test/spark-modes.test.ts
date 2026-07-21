import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BUILTIN_MODES,
  MODE_TOOL_STATUS_ACTION,
  assembleModeSystemPrompt,
  composeAgentSystemPrompt,
  createModeRegistry,
  createModeTool,
  normalizeModeToolAction,
  renderModeMarker,
  resolveActiveMode,
  resolveTurnDriver,
  runModeToolAction,
  type ModeDefinition,
} from "../packages/spark-modes/src/index.ts";

function builtinDefinitions(): ModeDefinition[] {
  return BUILTIN_MODES.map((id) => ({
    id,
    title: id[0].toUpperCase() + id.slice(1),
    builtin: true,
    renderRequirements: (context) =>
      `## ${id} requirements\n- driver=${context.driver}${context.focus ? `\n- focus=${context.focus}` : ""}`,
  }));
}

test("createModeRegistry preserves order, supports custom modes, and reports builtins", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  registry.register({
    id: "audit",
    title: "Audit",
    renderRequirements: () => "## audit requirements",
  });
  assert.deepEqual(registry.ids(), ["plan", "implement", "audit"]);
  assert.deepEqual(registry.builtinIds(), ["plan", "implement"]);
  assert.equal(registry.has("audit"), true);
  assert.equal(registry.get("audit")?.title, "Audit");
  assert.equal(registry.require("plan").id, "plan");
  assert.throws(() => registry.require("nope"), /unknown mode: nope/u);
});

test("createModeRegistry re-registration overwrites without duplicating order", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  registry.register({
    id: "plan",
    title: "Plan v2",
    builtin: true,
    renderRequirements: () => "v2",
  });
  assert.deepEqual(registry.ids(), ["plan", "implement"]);
  assert.equal(registry.require("plan").title, "Plan v2");
});

test("resolveActiveMode honors explicit > suggested > fallback precedence", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.deepEqual(
    resolveActiveMode({
      registry,
      driver: "assist",
      explicitSelection: "plan",
      suggest: "implement",
    }),
    { mode: "plan", driver: "assist", source: "explicit" },
  );
  assert.deepEqual(resolveActiveMode({ registry, driver: "goal", suggest: "implement" }), {
    mode: "implement",
    driver: "goal",
    source: "suggested",
  });
  assert.deepEqual(resolveActiveMode({ registry, driver: "assist" }), {
    mode: "plan",
    driver: "assist",
    source: "fallback",
  });
});

test("resolveActiveMode ignores unknown explicit/suggested ids and falls through", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.deepEqual(
    resolveActiveMode({
      registry,
      driver: "assist",
      explicitSelection: "bogus",
      suggest: "plan",
    }),
    { mode: "plan", driver: "assist", source: "suggested" },
  );
  assert.deepEqual(resolveActiveMode({ registry, driver: "assist", suggest: "bogus" }), {
    mode: "plan",
    driver: "assist",
    source: "fallback",
  });
});

test("resolveActiveMode uses first registered mode when fallback is unregistered", () => {
  const registry = createModeRegistry({
    definitions: [{ id: "only", title: "Only", renderRequirements: () => "x" }],
  });
  assert.deepEqual(resolveActiveMode({ registry, driver: "assist" }), {
    mode: "only",
    driver: "assist",
    source: "fallback",
  });
});

test("resolveActiveMode throws on an empty registry", () => {
  const registry = createModeRegistry();
  assert.throws(() => resolveActiveMode({ registry, driver: "assist" }), /registry is empty/u);
});

test("resolveTurnDriver prefers workflow over repro over goal over loop over assist", () => {
  assert.equal(
    resolveTurnDriver({ workflowRunActive: true, reproActive: true, goalLoopActive: true }),
    "workflow",
  );
  assert.equal(resolveTurnDriver({ reproActive: true, goalLoopActive: true }), "repro");
  assert.equal(resolveTurnDriver({ goalLoopActive: true }), "goal");
  assert.equal(resolveTurnDriver({ loopActive: true }), "loop");
  assert.equal(resolveTurnDriver({}), "assist");
});

test("createModeTool exposes registry ids plus status as actions", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  const tool = createModeTool({ registry });
  assert.equal(tool.name, "mode");
  assert.match(tool.description, /plan \| implement \| status/u);
});

test("normalizeModeToolAction validates against registry and status", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.equal(normalizeModeToolAction(undefined, registry), MODE_TOOL_STATUS_ACTION);
  assert.equal(normalizeModeToolAction("plan", registry), "plan");
  assert.equal(normalizeModeToolAction(" status ", registry), MODE_TOOL_STATUS_ACTION);
  assert.throws(() => normalizeModeToolAction("bogus", registry), /mode action must be one of/u);
});

test("runModeToolAction reports status without switching and switches otherwise", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  const status = runModeToolAction({
    action: MODE_TOOL_STATUS_ACTION,
    registry,
    currentMode: "plan",
    context: { driver: "assist" },
  });
  assert.equal(status.statusOnly, true);
  assert.equal(status.mode, "plan");
  assert.match(status.text, /Current lens: plan/u);

  const switched = runModeToolAction({
    action: "implement",
    registry,
    currentMode: "plan",
    context: { driver: "goal", focus: "ship" },
  });
  assert.equal(switched.statusOnly, false);
  assert.equal(switched.mode, "implement");
  assert.match(switched.text, /Lens set to: implement/u);
  assert.match(switched.text, /driver=goal/u);
  assert.match(switched.text, /focus=ship/u);
});

test("renderModeMarker shows phase only for assist and drive for autonomous drivers", () => {
  assert.equal(renderModeMarker({ mode: "plan", driver: "assist" }), undefined);
  assert.equal(
    renderModeMarker({ mode: "plan", driver: "assist", toolsHint: "Tools: x" }),
    "Tools: x",
  );
  assert.equal(renderModeMarker({ mode: "implement", driver: "assist" }), "Phase: implement.");
  assert.equal(renderModeMarker({ mode: "implement", driver: "goal" }), "Drive: goal.");
  assert.equal(
    renderModeMarker({ mode: "plan", driver: "loop", toolsHint: "Tools: x" }),
    "Drive: loop. Tools: x",
  );
});

test("composeAgentSystemPrompt drops empty sections", () => {
  assert.equal(
    composeAgentSystemPrompt(["identity", "  ", undefined, "surface", null, ""]),
    "identity\n\nsurface",
  );
});

test("assembleModeSystemPrompt joins non-empty sections in order", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  const prompt = assembleModeSystemPrompt({
    basePrompt: "BASE",
    registry,
    mode: "plan",
    context: { driver: "assist" },
    marker: "Phase: plan.",
    trailingContext: "## Project summary",
  });
  assert.equal(
    prompt,
    "BASE\n\nPhase: plan.\n\n## plan requirements\n- driver=assist\n\n## Project summary",
  );

  const minimal = assembleModeSystemPrompt({
    registry,
    mode: "plan",
    context: { driver: "assist" },
  });
  assert.equal(minimal, "## plan requirements\n- driver=assist");
});
