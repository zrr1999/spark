import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/pi-tasks";
import { hasNonSparkProjectFiles } from "./spark-activation.ts";
import {
  analyzeSparkEntryMode,
  type SparkCommandProjectState,
  type SparkEntryIntent,
  type SparkEntryMode,
  type SparkEntryModeChoice,
  type SparkEntryResolution,
} from "./spark-entry.ts";
import { currentSparkProject } from "./session-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export type SparkEntryResolutionContext = Pick<
  SparkToolContext,
  "cwd" | "sessionManager" | "ui"
> & {
  setEditorText?: (text: string) => void;
};

export async function detectSparkProjectState(
  cwd: string,
  graph: TaskGraph | null,
  ctx: SparkEntryResolutionContext,
): Promise<SparkCommandProjectState> {
  if (graph) {
    const project = await currentSparkProject(cwd, ctx, graph);
    return {
      kind: "initialized",
      hasCurrentProject: Boolean(project),
      unfinishedTaskCount: graph
        .tasks(project?.ref)
        .filter((task) => isUnfinishedTaskStatus(task.status)).length,
    };
  }
  return {
    kind: (await hasNonSparkProjectFiles(cwd)) ? "existing_project" : "empty_project",
    hasCurrentProject: false,
    unfinishedTaskCount: 0,
  };
}

export async function resolveSparkEntry(
  ctx: SparkEntryResolutionContext,
  intent: SparkEntryIntent,
  graph: TaskGraph | null,
  projectState: SparkCommandProjectState,
): Promise<SparkEntryResolution> {
  if (!graph) return resolveSparkEntryWithoutGraph(ctx, intent, projectState);

  const mode =
    intent.kind === "direct"
      ? intent.mode
      : await chooseInitializedSparkMode(ctx, graph, projectState, intent.prompt);
  if (!mode) return { action: "none" };
  if (mode === "new_project") {
    const idea = intent.prompt || (await promptSparkNewProjectIdea(ctx));
    return idea
      ? { action: "initialize_new_project", idea, enterPlanning: true, planningSource: "auto" }
      : { action: "none" };
  }
  return {
    action: "enter_mode",
    mode,
    focus: intent.prompt || undefined,
    planningSource: intent.kind === "direct" && mode === "plan" ? "direct" : "auto",
  };
}

async function resolveSparkEntryWithoutGraph(
  ctx: SparkEntryResolutionContext,
  intent: SparkEntryIntent,
  projectState: SparkCommandProjectState,
): Promise<SparkEntryResolution> {
  if (projectState.kind === "empty_project") {
    if (intent.kind === "auto") {
      const idea = intent.prompt || (await promptSparkNewProjectIdea(ctx));
      return idea
        ? { action: "initialize_new_project", idea, enterPlanning: false, planningSource: "auto" }
        : { action: "none" };
    }
    return blockedDirectModeWithoutGraph(intent.mode);
  }

  if (intent.kind === "direct") return blockedDirectModeWithoutGraph(intent.mode);

  const idea = intent.prompt || (await inferExistingProjectSparkIdea(ctx));
  return idea
    ? {
        action: "initialize_existing_project",
        idea,
        planningSource: "auto",
      }
    : { action: "none" };
}

function blockedDirectModeWithoutGraph(mode: SparkEntryMode): SparkEntryResolution {
  return {
    action: "blocked",
    message: `Spark ${mode} mode needs initialized Spark project state. Create or select a project with task_write({ action: "project_use", title, description }) before using this mode.`,
  };
}

async function chooseInitializedSparkMode(
  ctx: SparkEntryResolutionContext,
  graph: TaskGraph,
  projectState: SparkCommandProjectState,
  prompt: string,
): Promise<SparkEntryModeChoice | undefined> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const analysis = analyzeSparkEntryMode(graph, projectState, prompt, project);
  return analysis.recommendation;
}

async function inferExistingProjectSparkIdea(
  ctx: SparkEntryResolutionContext,
): Promise<string | undefined> {
  const inferred = await inferExistingProjectFocusFromContext(ctx.cwd);
  const idea = await ctx.ui?.input?.(
    "What should Spark plan for this existing project?",
    inferred ?? "",
  );
  const trimmed = idea?.trim();
  if (trimmed) return trimmed;
  if (inferred) {
    ctx.ui?.notify?.("Spark inferred a planning focus from project context.", "info");
    return inferred;
  }
  ctx.ui?.notify?.(
    'Spark planning needs a concrete focus for this existing project. Create or select a project with task_write({ action: "project_use", title, description }) before planning.',
    "warning",
  );
  return undefined;
}

interface ExistingProjectContextHint {
  title?: string;
  description?: string;
  signals: string[];
}

async function inferExistingProjectFocusFromContext(cwd: string): Promise<string | undefined> {
  const hints = await collectExistingProjectContextHints(cwd);
  const title = (hints.title ?? basename(cwd)) || "Existing project";
  const lines = [title];
  if (hints.description) lines.push(`Context summary: ${hints.description}`);
  if (hints.signals.length > 0)
    lines.push(`Detected project signals: ${hints.signals.join(", ")}.`);
  lines.push(
    "Planning focus: inspect the repository context, infer the current project purpose, and plan only concrete next work after any context-specific clarification needed.",
  );
  return lines.join("\n");
}

async function collectExistingProjectContextHints(
  cwd: string,
): Promise<ExistingProjectContextHint> {
  const entries = await safeReadDirectoryNames(cwd);
  const signals = inferProjectSignals(entries);
  const packageJson = await readJsonObject(join(cwd, "package.json"));
  const cargoToml = await safeReadText(join(cwd, "Cargo.toml"));
  const pyprojectToml = await safeReadText(join(cwd, "pyproject.toml"));
  const readme = await readFirstExistingText(
    ["README.md", "README.mdx", "README.txt", "readme.md"].map((name) => join(cwd, name)),
  );
  const readmeSummary = readme ? parseReadmeSummary(readme) : undefined;

  return {
    title:
      stringField(packageJson, "name") ??
      tomlString(cargoToml, "name") ??
      tomlString(pyprojectToml, "name") ??
      readmeSummary?.title,
    description:
      stringField(packageJson, "description") ??
      tomlString(cargoToml, "description") ??
      tomlString(pyprojectToml, "description") ??
      readmeSummary?.description,
    signals,
  };
}

async function safeReadDirectoryNames(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries
      .map((entry) => entry.name)
      .filter((name) => ![".git", ".spark", "node_modules", ".pi"].includes(name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function inferProjectSignals(entries: string[]): string[] {
  const names = new Set(entries);
  const signals = new Set<string>();
  if (names.has("package.json")) signals.add("Node/package.json");
  if (names.has("tsconfig.json")) signals.add("TypeScript");
  if (names.has("vite.config.ts") || names.has("vite.config.js")) signals.add("Vite");
  if (names.has("pnpm-workspace.yaml")) signals.add("pnpm workspace");
  if (names.has("Cargo.toml")) signals.add("Rust/Cargo");
  if (names.has("pyproject.toml")) signals.add("Python/pyproject");
  if (names.has("go.mod")) signals.add("Go module");
  if (names.has("README.md") || names.has("README.mdx") || names.has("README.txt"))
    signals.add("README");
  if (names.has("AGENTS.md")) signals.add("agent instructions");
  return [...signals];
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await safeReadText(path);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readFirstExistingText(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const text = await safeReadText(path);
    if (text) return text;
  }
  return undefined;
}

async function safeReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseReadmeSummary(text: string): { title?: string; description?: string } {
  const lines = text.split(/\r?\n/u);
  const title = lines
    .find((line) => /^#\s+\S/u.test(line))
    ?.replace(/^#\s+/u, "")
    .trim();
  const description = lines
    .map((line) => line.trim())
    .find(
      (line) =>
        line &&
        !line.startsWith("#") &&
        !line.startsWith("[") &&
        !line.startsWith("!") &&
        !line.startsWith("```") &&
        !line.startsWith("---"),
    );
  return { title, description };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tomlString(text: string | undefined, key: string): string | undefined {
  const match = text?.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, "mu"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function promptSparkNewProjectIdea(
  ctx: SparkEntryResolutionContext,
): Promise<string | undefined> {
  const idea = await ctx.ui?.input?.(
    "What new Spark project or idea should this workspace start?",
    "",
  );
  const trimmed = idea?.trim();
  if (trimmed) return trimmed;
  ctx.ui?.notify?.(
    "Spark new-project mode needs an idea; provide a concrete project title or description before initializing.",
    "warning",
  );
  return undefined;
}
