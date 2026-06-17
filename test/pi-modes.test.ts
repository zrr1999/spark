import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_MODES,
  MODE_TOOL_STATUS_ACTION,
  assembleModeSystemPrompt,
  createModeRegistry,
  createModeTool,
  normalizeModeToolAction,
  renderModeMarker,
  resolveActiveMode,
  resolveTurnDriver,
  runModeToolAction,
  type ModeDefinition,
} from "../packages/pi-modes/src/index.ts";

function builtinDefinitions(): ModeDefinition[] {
  return BUILTIN_MODES.map((id) => ({
    id,
    title: id[0].toUpperCase() + id.slice(1),
    builtin: true,
    renderRequirements: (context) =>
      `## ${id} requirements\n- driver=${context.driver}${context.focus ? `\n- focus=${context.focus}` : ""}`,
  }));
}

void test("createModeRegistry preserves order, supports custom modes, and reports builtins", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  registry.register({
    id: "audit",
    title: "Audit",
    renderRequirements: () => "## audit requirements",
  });
  assert.deepEqual(registry.ids(), ["research", "plan", "implement", "audit"]);
  assert.deepEqual(registry.builtinIds(), ["research", "plan", "implement"]);
  assert.equal(registry.has("audit"), true);
  assert.equal(registry.get("audit")?.title, "Audit");
  assert.equal(registry.require("research").id, "research");
  assert.throws(() => registry.require("nope"), /unknown mode: nope/u);
});

void test("createModeRegistry re-registration overwrites without duplicating order", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  registry.register({
    id: "research",
    title: "Research v2",
    builtin: true,
    renderRequirements: () => "v2",
  });
  assert.deepEqual(registry.ids(), ["research", "plan", "implement"]);
  assert.equal(registry.require("research").title, "Research v2");
});

void test("resolveActiveMode honors explicit > suggested > fallback precedence", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.deepEqual(
    resolveActiveMode({
      registry,
      driver: "interactive",
      explicitSelection: "plan",
      suggest: "implement",
    }),
    { mode: "plan", driver: "interactive", source: "explicit" },
  );
  assert.deepEqual(resolveActiveMode({ registry, driver: "goal", suggest: "implement" }), {
    mode: "implement",
    driver: "goal",
    source: "suggested",
  });
  assert.deepEqual(resolveActiveMode({ registry, driver: "interactive" }), {
    mode: "research",
    driver: "interactive",
    source: "fallback",
  });
});

void test("resolveActiveMode ignores unknown explicit/suggested ids and falls through", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.deepEqual(
    resolveActiveMode({
      registry,
      driver: "interactive",
      explicitSelection: "bogus",
      suggest: "plan",
    }),
    { mode: "plan", driver: "interactive", source: "suggested" },
  );
  assert.deepEqual(resolveActiveMode({ registry, driver: "interactive", suggest: "bogus" }), {
    mode: "research",
    driver: "interactive",
    source: "fallback",
  });
});

void test("resolveActiveMode uses first registered mode when fallback is unregistered", () => {
  const registry = createModeRegistry({
    definitions: [{ id: "only", title: "Only", renderRequirements: () => "x" }],
  });
  assert.deepEqual(resolveActiveMode({ registry, driver: "interactive" }), {
    mode: "only",
    driver: "interactive",
    source: "fallback",
  });
});

void test("resolveActiveMode throws on an empty registry", () => {
  const registry = createModeRegistry();
  assert.throws(() => resolveActiveMode({ registry, driver: "interactive" }), /registry is empty/u);
});

void test("resolveTurnDriver prefers workflow over goal over interactive", () => {
  assert.equal(resolveTurnDriver({ workflowRunActive: true, goalLoopActive: true }), "workflow");
  assert.equal(resolveTurnDriver({ goalLoopActive: true }), "goal");
  assert.equal(resolveTurnDriver({}), "interactive");
});

void test("createModeTool exposes registry ids plus status as actions", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  const tool = createModeTool({ registry });
  assert.equal(tool.name, "mode");
  assert.match(tool.description, /research \| plan \| implement \| status/u);
});

void test("normalizeModeToolAction validates against registry and status", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.equal(normalizeModeToolAction(undefined, registry), MODE_TOOL_STATUS_ACTION);
  assert.equal(normalizeModeToolAction("plan", registry), "plan");
  assert.equal(normalizeModeToolAction(" status ", registry), MODE_TOOL_STATUS_ACTION);
  assert.throws(() => normalizeModeToolAction("bogus", registry), /mode action must be one of/u);
});

void test("runModeToolAction reports status without switching and switches otherwise", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  const status = runModeToolAction({
    action: MODE_TOOL_STATUS_ACTION,
    registry,
    currentMode: "plan",
    context: { driver: "interactive" },
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

void test("renderModeMarker suppresses the trivial research/interactive combination", () => {
  assert.equal(renderModeMarker({ mode: "research", driver: "interactive" }), undefined);
  assert.equal(
    renderModeMarker({ mode: "research", driver: "interactive", toolsHint: "Tools: x" }),
    "Tools: x",
  );
  assert.equal(renderModeMarker({ mode: "plan", driver: "interactive" }), "Mode: plan.");
  assert.equal(renderModeMarker({ mode: "implement", driver: "goal" }), "Mode: implement · goal.");
});

void test("assembleModeSystemPrompt joins non-empty sections in order", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  const prompt = assembleModeSystemPrompt({
    basePrompt: "BASE",
    registry,
    mode: "plan",
    context: { driver: "interactive" },
    marker: "Mode: plan.",
    trailingContext: "## Project summary",
  });
  assert.equal(
    prompt,
    "BASE\n\nMode: plan.\n\n## plan requirements\n- driver=interactive\n\n## Project summary",
  );

  const minimal = assembleModeSystemPrompt({
    registry,
    mode: "research",
    context: { driver: "interactive" },
  });
  assert.equal(minimal, "## research requirements\n- driver=interactive");
});
