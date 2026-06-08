import { defaultTaskGraphStore, type TaskGraph } from "pi-tasks";
import { renderActiveSparkContext } from "./spark-active-context.ts";
import {
  detectSparkActivation,
  hasLocalSparkDirectory,
  readActiveSparkMd,
} from "./spark-activation.ts";
import { ensureSparkClaimReaper, sweepExpiredSparkClaims } from "./spark-claim-reaper.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkMode,
  saveSparkGraphAndTodos,
  sparkSessionKey,
  type SparkSessionContext,
  type SparkSessionMode,
} from "./session-state.ts";
import { loadIndependentTodos } from "./session-todos.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import type { SparkModeEntryDeps, SparkModeMessageApi } from "./spark-mode-entry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

interface SparkInputEvent {
  text: string;
  source?: string;
}

export interface SparkInputModeRouter {
  piApi: SparkModeMessageApi;
  deps: SparkModeEntryDeps;
}

export async function handleSparkInput(
  event: unknown,
  ctx: SparkToolContext,
  _router?: SparkInputModeRouter,
): Promise<unknown> {
  if (!isSparkInputEvent(event)) return { action: "continue" };
  if (event.source === "extension") return { action: "continue" };
  const text = event.text.trim();
  if (!text || text.startsWith("/")) return { action: "continue" };
  const activation = await detectSparkActivation(ctx.cwd);
  if (!activation.active) return { action: "continue" };
  const mode = await loadSparkMode(ctx.cwd, ctx);
  if (mode.mode !== "auto") return { action: "continue" };
  return { action: "continue" };
}

export async function injectSparkHints(event: unknown, ctx: SparkToolContext): Promise<unknown> {
  const activation = await detectSparkActivation(ctx.cwd);
  if (!activation.active) return undefined;
  await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
  const contextSummary = await renderActiveSparkContextSummary(ctx.cwd, ctx);
  const mode = (await loadSparkMode(ctx.cwd, ctx)).mode;
  const sparkPrompt = renderSparkActiveSystemPrompt(
    eventSystemPrompt(event),
    activation.reason,
    mode,
  );
  return {
    systemPrompt: contextSummary ? `${sparkPrompt}\n\n${contextSummary}` : sparkPrompt,
  };
}

export async function renderActiveSparkContextSummary(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<string | undefined> {
  const store = defaultTaskGraphStore(cwd);
  const graph = await loadSparkGraph(cwd, ctx);
  if (!graph) return undefined;
  if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(cwd, graph, ctx, store);
  const sparkMd = await readActiveSparkMd(cwd);
  const project = await currentSparkProject(cwd, ctx, graph);
  const sessionKey = sparkSessionKey(ctx);
  const independentTodos = await loadIndependentTodos(cwd, ctx);
  const sessionGoal = await loadSessionGoal(cwd, ctx);
  return renderActiveSparkContext({
    graph,
    project,
    sessionKey,
    independentTodos,
    sessionGoal,
    sparkMd,
  });
}

export async function ensureSparkStateForActiveWorkspace(
  cwd: string,
  ctx?: SparkSessionContext,
  options: { skipSweep?: boolean } = {},
): Promise<TaskGraph | null> {
  if (!(await hasLocalSparkDirectory(cwd))) return null;
  if (!options.skipSweep) await sweepExpiredSparkClaims(cwd, ctx);
  ensureSparkClaimReaper(cwd);
  return loadSparkGraph(cwd, ctx);
}

export function renderSparkActiveSystemPrompt(
  basePrompt: string,
  reason: string,
  mode: SparkSessionMode = "auto",
): string {
  const sparkPrompt = `Spark active (${reason}); mode: ${mode}. Spark is the mode facade; use task, artifact, ask, role, learning, context, recall, and workflow tools. ≤1 task; no canned asks; no guessing: ask unless user says infer/research.`;
  return basePrompt ? `${basePrompt}\n\n${sparkPrompt}` : sparkPrompt;
}

function isSparkInputEvent(event: unknown): event is SparkInputEvent {
  return Boolean(
    event && typeof event === "object" && typeof (event as { text?: unknown }).text === "string",
  );
}

function eventSystemPrompt(event: unknown): string {
  return event &&
    typeof event === "object" &&
    typeof (event as { systemPrompt?: unknown }).systemPrompt === "string"
    ? (event as { systemPrompt: string }).systemPrompt
    : "";
}
