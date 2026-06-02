import { defaultTaskGraphStore, type TaskGraph } from "spark-tasks";
import { renderActiveSparkContext } from "./spark-active-context.ts";
import {
  detectNaturalSparkIntent,
  detectSparkActivation,
  hasLocalSparkDirectory,
  readActiveSparkMd,
} from "./spark-activation.ts";
import { ensureSparkClaimReaper, sweepExpiredSparkClaims } from "./spark-claim-reaper.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  sparkSessionKey,
  sparkTodoStore,
  type SparkSessionContext,
} from "./session-state.ts";
import { loadIndependentTodos } from "./session-todos.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

interface SparkInputEvent {
  text: string;
  source?: string;
}

export async function handleSparkInput(event: unknown, ctx: SparkToolContext): Promise<unknown> {
  if (!isSparkInputEvent(event)) return { action: "continue" };
  if (event.source === "extension") return { action: "continue" };
  const text = event.text.trim();
  if (!text || text.startsWith("/")) return { action: "continue" };
  const activation = await detectSparkActivation(ctx.cwd);
  if (activation.active) return { action: "continue" };
  const intent = detectNaturalSparkIntent(text);
  if (intent === "new_idea") return { action: "transform", text: `/spark ${text}` };
  return { action: "continue" };
}

export async function injectSparkHints(event: unknown, ctx: SparkToolContext): Promise<unknown> {
  const activation = await detectSparkActivation(ctx.cwd);
  if (!activation.active) return undefined;
  await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
  const contextSummary = await renderActiveSparkContextSummary(ctx.cwd, ctx);
  const sparkPrompt = renderSparkActiveSystemPrompt(eventSystemPrompt(event), activation.reason);
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
  if (ensureSparkGraphInvariants(graph)) {
    await store.save(graph);
    await sparkTodoStore(cwd, ctx).save(graph);
  }
  const sparkMd = await readActiveSparkMd(cwd);
  const project = await currentSparkProject(cwd, ctx, graph);
  const sessionKey = sparkSessionKey(ctx);
  const independentTodos = await loadIndependentTodos(cwd, ctx);
  return renderActiveSparkContext({ graph, project, sessionKey, independentTodos, sparkMd });
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

export function renderSparkActiveSystemPrompt(basePrompt: string, reason: string): string {
  const sparkPrompt = [
    `Spark is active for this workspace (${reason}).`,
    "Use the injected Active Spark context as standing project state; read SPARK.md or the spark skill only when you need full intent or workflow details.",
    "Follow the active workflow contract: use Spark tools for project/task/TODO/workflow-run/ask state, claim at most one unfinished session task, ask via Spark ask tools (`spark_ask`) for real blockers or missing decisions, and fix concrete repo behavior feedback in code/docs/tests instead of treating it as memory-only.",
  ].join(" ");
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
