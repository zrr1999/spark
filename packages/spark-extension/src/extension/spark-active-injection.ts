import { defaultTaskGraphStore, type TaskGraph } from "@zendev-lab/pi-tasks";
import { renderActiveSparkContext } from "./spark-active-context.ts";
import { ensureLocalSparkDirectory, readActiveSparkMd } from "./spark-activation.ts";
import { ensureSparkClaimReaper, sweepExpiredSparkClaims } from "./spark-claim-reaper.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkPhase,
  saveSparkGraphAndTodos,
  sparkSessionKey,
  type SparkSessionContext,
  type SparkSessionPhase,
} from "./session-state.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { sparkLanguageForProject, type SparkLanguage } from "./spark-i18n.ts";
import { renderSparkPhaseSystemPrompt } from "./mode/index.ts";
import { renderBaseSystemPromptsPrompt } from "./spark-builtin-skills.ts";
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
  _ctx: SparkToolContext,
  _router?: SparkInputModeRouter,
): Promise<unknown> {
  if (!isSparkInputEvent(event)) return { action: "continue" };
  if (event.source === "extension") return { action: "continue" };
  const text = event.text.trim();
  if (!text || text.startsWith("/")) return { action: "continue" };
  return { action: "continue" };
}

export async function injectSparkHints(event: unknown, ctx: SparkToolContext): Promise<unknown> {
  // Spark is always available: inject the standing phase marker even when no
  // local .spark/ state exists yet. The richer active-context block is only
  // appended once a task graph is present.
  const phase = (await loadSparkPhase(ctx.cwd, ctx)).phase;
  const graph = await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
  const summary = graph ? await renderActiveSparkContextWithLanguage(ctx.cwd, ctx) : undefined;
  const sparkPrompt = renderSparkActiveSystemPrompt(
    eventSystemPrompt(event),
    phase,
    summary?.language,
  );
  const builtinSkillsPrompt = await renderBaseSystemPromptsPrompt();
  const sections = [sparkPrompt, builtinSkillsPrompt, summary?.content].filter(
    (section): section is string => Boolean(section),
  );
  return { systemPrompt: sections.join("\n\n") };
}

export interface ActiveSparkContextSummary {
  content: string;
  language: SparkLanguage;
}

async function renderActiveSparkContextWithLanguage(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<ActiveSparkContextSummary | undefined> {
  const graph = await loadSparkGraph(cwd, ctx);
  if (!graph) return undefined;
  const store = defaultTaskGraphStore(cwd);
  if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(cwd, graph, ctx, store);
  const sparkMd = await readActiveSparkMd(cwd);
  const project = await currentSparkProject(cwd, ctx, graph);
  const sessionKey = sparkSessionKey(ctx);
  const sessionGoal = await loadSessionGoal(cwd, ctx);
  const language = sparkLanguageForProject({
    project,
    goal: sessionGoal,
    fallbackText: sparkMd,
  });
  const content = renderActiveSparkContext({
    graph,
    project,
    sessionKey,
    sessionGoal,
    sparkMd,
    language,
  });
  if (!content) return undefined;
  return { content, language };
}

export async function renderActiveSparkContextSummary(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<string | undefined> {
  return (await renderActiveSparkContextWithLanguage(cwd, ctx))?.content;
}

export async function ensureSparkStateForActiveWorkspace(
  cwd: string,
  ctx?: SparkSessionContext,
  options: { skipSweep?: boolean } = {},
): Promise<TaskGraph | null> {
  await ensureLocalSparkDirectory(cwd);
  if (!options.skipSweep) await sweepExpiredSparkClaims(cwd, ctx);
  ensureSparkClaimReaper(cwd);
  return loadSparkGraph(cwd, ctx);
}

export function renderSparkActiveSystemPrompt(
  basePrompt: string,
  phase: SparkSessionPhase = "research",
  language?: SparkLanguage,
): string {
  return renderSparkPhaseSystemPrompt({ basePrompt, phase, language });
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
