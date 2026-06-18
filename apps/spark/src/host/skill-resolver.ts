/** Skill discovery for the native Spark CLI host. */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  defaultBuiltinSkillsDir,
  parseSkillFrontmatter,
  type SparkSkillFrontmatter,
} from "../../../../packages/spark/src/extension/spark-builtin-skills.ts";

export { defaultBuiltinSkillsDir, parseSkillFrontmatter };
export type { SparkSkillFrontmatter };

export type SparkSkillLayer = "builtin" | "workspace" | "user";

export interface SparkSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  layer: SparkSkillLayer;
  disabled: boolean;
  disableModelInvocation: boolean;
  frontmatter: SparkSkillFrontmatter;
}

export interface SparkSkillDiagnostic {
  type: "warning" | "collision";
  message: string;
  path?: string;
  winnerPath?: string;
  loserPath?: string;
}

export interface SparkSkillResolverOptions {
  cwd: string;
  sparkHome?: string;
  builtinDirs?: string[];
  workspaceDir?: string;
  userDir?: string;
}

export interface SparkSkillResolveResult {
  skills: SparkSkill[];
  diagnostics: SparkSkillDiagnostic[];
}

export interface SparkSkillPromptMatch {
  skill: SparkSkill;
  content: string;
  score: number;
}

export class SparkSkillResolver {
  readonly cwd: string;
  readonly builtinDirs: string[];
  readonly workspaceDir: string;
  readonly userDir: string;

  constructor(options: SparkSkillResolverOptions) {
    this.cwd = resolve(options.cwd);
    this.builtinDirs = options.builtinDirs?.map((dir) => resolvePath(dir, this.cwd)) ?? [
      defaultBuiltinSkillsDir(),
    ];
    this.workspaceDir = resolvePath(
      options.workspaceDir ?? join(this.cwd, ".spark", "skills"),
      this.cwd,
    );
    this.userDir = resolvePath(
      options.userDir ?? defaultUserSkillsDir(options.sparkHome),
      this.cwd,
    );
  }

  async resolve(): Promise<SparkSkillResolveResult> {
    const diagnostics: SparkSkillDiagnostic[] = [];
    const skillsByName = new Map<string, SparkSkill>();

    for (const layer of skillLayerSpecs(this)) {
      for (const dir of layer.dirs) {
        const result = await loadSkillsFromDir(dir, layer.layer);
        diagnostics.push(...result.diagnostics);
        for (const skill of result.skills) {
          if (skill.disabled) continue;
          const existing = skillsByName.get(skill.name);
          if (existing) {
            diagnostics.push({
              type: "collision",
              message: `skill "${skill.name}" from ${skill.layer} overrides ${existing.layer}`,
              path: skill.filePath,
              winnerPath: skill.filePath,
              loserPath: existing.filePath,
            });
          }
          skillsByName.set(skill.name, skill);
        }
      }
    }

    return { skills: [...skillsByName.values()], diagnostics };
  }

  async formatAvailableSkillsForPrompt(): Promise<string> {
    const { skills } = await this.resolve();
    return formatSparkSkillsForPrompt(skills);
  }

  async loadMatchingSkillsForPrompt(request: string, limit = 3): Promise<SparkSkillPromptMatch[]> {
    const { skills } = await this.resolve();
    return loadMatchingSparkSkillsForPrompt(skills, request, limit);
  }
}

export function defaultSparkSkillsRoot(sparkHome?: string): string {
  return sparkHome ?? process.env.SPARK_HOME ?? join(homedir(), ".spark");
}

export function defaultUserSkillsDir(sparkHome?: string): string {
  return join(defaultSparkSkillsRoot(sparkHome), "skills");
}

export async function loadSkillsFromDir(
  dir: string,
  layer: SparkSkillLayer,
): Promise<SparkSkillResolveResult> {
  const skills: SparkSkill[] = [];
  const diagnostics: SparkSkillDiagnostic[] = [];
  const root = resolve(dir);
  await scanSkillDir(root, layer, true, skills, diagnostics);
  return { skills, diagnostics };
}

export function formatSparkSkillsForPrompt(skills: SparkSkill[]): string {
  const visible = skills.filter((skill) => !skill.disabled && !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export async function loadMatchingSparkSkillsForPrompt(
  skills: SparkSkill[],
  request: string,
  limit = 3,
): Promise<SparkSkillPromptMatch[]> {
  const visible = skills.filter((skill) => !skill.disabled && !skill.disableModelInvocation);
  const ranked = visible
    .map((skill) => ({ skill, score: scoreSkillMatch(skill, request) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(0, limit));

  const matches: SparkSkillPromptMatch[] = [];
  for (const match of ranked) {
    matches.push({ ...match, content: await readFile(match.skill.filePath, "utf8") });
  }
  return matches;
}

async function scanSkillDir(
  dir: string,
  layer: SparkSkillLayer,
  includeRootMarkdownFiles: boolean,
  skills: SparkSkill[],
  diagnostics: SparkSkillDiagnostic[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ type: "warning", message: errorMessage(error), path: dir });
    }
    return;
  }

  const skillFile = entries.find((entry) => entry.name === "SKILL.md");
  if (skillFile) {
    const filePath = join(dir, skillFile.name);
    if (await isFileLike(filePath, skillFile)) {
      const loaded = await loadSkillFromFile(filePath, layer);
      if (loaded.skill) skills.push(loaded.skill);
      diagnostics.push(...loaded.diagnostics);
      return;
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    if (await isDirectoryLike(fullPath, entry)) {
      await scanSkillDir(fullPath, layer, false, skills, diagnostics);
      continue;
    }
    if (!includeRootMarkdownFiles || !entry.name.endsWith(".md")) continue;
    if (!(await isFileLike(fullPath, entry))) continue;
    const loaded = await loadSkillFromFile(fullPath, layer);
    if (loaded.skill) skills.push(loaded.skill);
    diagnostics.push(...loaded.diagnostics);
  }
}

async function loadSkillFromFile(
  filePath: string,
  layer: SparkSkillLayer,
): Promise<{ skill?: SparkSkill; diagnostics: SparkSkillDiagnostic[] }> {
  const diagnostics: SparkSkillDiagnostic[] = [];
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return { diagnostics: [{ type: "warning", message: errorMessage(error), path: filePath }] };
  }

  const { frontmatter } = parseSkillFrontmatter(raw);
  const description = stringField(frontmatter.description);
  if (!description) {
    diagnostics.push({ type: "warning", message: "description is required", path: filePath });
    return { diagnostics };
  }

  const baseDir = dirname(filePath);
  const name = stringField(frontmatter.name) ?? basename(baseDir).toLowerCase();
  if (!isValidSkillName(name)) {
    diagnostics.push({
      type: "warning",
      message: `skill name "${name}" should use lowercase letters, digits, and hyphens`,
      path: filePath,
    });
  }

  return {
    skill: {
      name,
      description,
      filePath,
      baseDir,
      layer,
      disabled: frontmatter.disabled === true,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      frontmatter,
    },
    diagnostics,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;
}

function scoreSkillMatch(skill: SparkSkill, request: string): number {
  const haystack = `${skill.name} ${skill.description}`.toLowerCase();
  const words = skillSearchWords(request);
  let score = 0;
  for (const word of new Set(words)) {
    if (skill.name.includes(word)) score += 4;
    if (haystack.includes(word)) score += 1;
  }
  return score;
}

function skillSearchWords(request: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const char of request.toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-") {
      current += char;
    } else {
      if (current.length >= 3) words.push(current);
      current = "";
    }
  }
  if (current.length >= 3) words.push(current);
  return words;
}

function skillLayerSpecs(
  resolver: SparkSkillResolver,
): Array<{ layer: SparkSkillLayer; dirs: string[] }> {
  return [
    { layer: "builtin", dirs: resolver.builtinDirs },
    { layer: "workspace", dirs: [resolver.workspaceDir] },
    { layer: "user", dirs: [resolver.userDir] },
  ];
}

async function isFileLike(
  path: string,
  entry: { isFile(): boolean; isSymbolicLink(): boolean },
): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectoryLike(
  path: string,
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function resolvePath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
