/** Host-neutral Spark builtin skill prompt rendering. */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SparkSkillFrontmatter {
  name?: string;
  description?: string;
  disabled?: boolean;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

export interface SparkBuiltinSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disabled: boolean;
  disableModelInvocation: boolean;
  frontmatter: SparkSkillFrontmatter;
  body: string;
}

export function defaultBuiltinSkillsDir(): string {
  const hostDir = dirname(fileURLToPath(import.meta.url));
  return resolve(hostDir, "../skills");
}

export function defaultSparkCueSkillsDir(): string {
  const hostDir = dirname(fileURLToPath(import.meta.url));
  const fromWorkspace = resolve(hostDir, "../../../spark-cue/skills");
  if (existsSync(fromWorkspace)) return fromWorkspace;
  try {
    const extensionPath = fileURLToPath(import.meta.resolve("@zendev-lab/spark-cue/extension"));
    const fromPackage = resolve(dirname(extensionPath), "../../skills");
    if (existsSync(fromPackage)) return fromPackage;
  } catch {
    // Fall through to the source-tree default below.
  }
  return resolve(process.cwd(), "packages", "spark-cue", "skills");
}

export function defaultBasePromptDirs(): string[] {
  return [defaultBuiltinSkillsDir(), defaultSparkCueSkillsDir()];
}

export function defaultBasePromptFiles(): string[] {
  return [];
}

export async function loadBuiltinSkills(
  dir = defaultBuiltinSkillsDir(),
): Promise<SparkBuiltinSkill[]> {
  const skills: SparkBuiltinSkill[] = [];
  await scanBuiltinSkillDir(resolve(dir), true, skills);
  return skills;
}

export function renderBuiltinSkillsForPrompt(skills: SparkBuiltinSkill[]): string {
  return renderBaseSystemPromptFilesForPrompt(skills);
}

/** Catalog-only prompt for production discovery; skill bodies stay on disk. */
export function renderBuiltinSkillsCatalogForPrompt(skills: SparkBuiltinSkill[]): string {
  const visible = skills.filter((skill) => !skill.disabled && !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "Resolve relative references against the skill directory containing the listed file.",
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

export function renderBaseSystemPromptFilesForPrompt(skills: SparkBuiltinSkill[]): string {
  const visible = skills.filter((skill) => !skill.disabled);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following base system prompt files are already loaded in full.",
    "Follow these instructions directly; do not use the read tool to load these files again.",
    "",
    "<base_system_prompts>",
  ];
  for (const skill of visible) {
    lines.push("  <prompt>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("    <content>");
    lines.push(skill.body.trimEnd());
    lines.push("    </content>");
    lines.push("  </prompt>");
  }
  lines.push("</base_system_prompts>");
  return lines.join("\n");
}

export async function renderBuiltinSkillsPrompt(dir = defaultBuiltinSkillsDir()): Promise<string> {
  return renderBuiltinSkillsForPrompt(await loadBuiltinSkills(dir));
}

export async function renderBaseSystemPromptsPrompt(
  input: {
    dirs?: string[];
    files?: string[];
  } = {},
): Promise<string> {
  const dirs = input.dirs ?? defaultBasePromptDirs();
  const files = input.files ?? defaultBasePromptFiles();
  const skills = (await Promise.all(dirs.map((dir) => loadBuiltinSkills(dir)))).flat();
  const filePrompts = await Promise.all(files.map((filePath) => loadBasePromptFile(filePath)));
  return renderBaseSystemPromptFilesForPrompt([...skills, ...filePrompts.filter(isDefined)]);
}

/**
 * Discover the same builtin/Cue skill sources as the legacy full renderer but
 * inject metadata only. Kept in pi-extension so the legacy Pi host does not
 * depend on the native app's resolver.
 */
export async function renderBaseSystemPromptsCatalogPrompt(
  input: {
    dirs?: string[];
    files?: string[];
  } = {},
): Promise<string> {
  const dirs = input.dirs ?? defaultBasePromptDirs();
  const files = input.files ?? defaultBasePromptFiles();
  const skills = (await Promise.all(dirs.map((dir) => loadBuiltinSkills(dir)))).flat();
  const filePrompts = await Promise.all(files.map((filePath) => loadBasePromptFile(filePath)));
  return renderBuiltinSkillsCatalogForPrompt([...skills, ...filePrompts.filter(isDefined)]);
}

export function parseSkillFrontmatter(markdown: string): {
  frontmatter: SparkSkillFrontmatter;
  body: string;
} {
  if (!markdown.startsWith("---\n")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: markdown };
  const raw = markdown.slice(4, end);
  const body = markdown.slice(end + "\n---".length).replace(/^(?:\r?\n)+/, "");
  return { frontmatter: parseSimpleYaml(raw), body };
}

async function scanBuiltinSkillDir(
  dir: string,
  includeRootMarkdownFiles: boolean,
  skills: SparkBuiltinSkill[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const skillFile = entries.find((entry) => entry.name === "SKILL.md");
  if (skillFile) {
    const filePath = resolve(dir, skillFile.name);
    if (await isFileLike(filePath, skillFile)) {
      const skill = await loadBuiltinSkillFromFile(filePath);
      if (skill) skills.push(skill);
      return;
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = resolve(dir, entry.name);
    if (await isDirectoryLike(fullPath, entry)) {
      await scanBuiltinSkillDir(fullPath, false, skills);
      continue;
    }
    if (!includeRootMarkdownFiles || !entry.name.endsWith(".md")) continue;
    if (!(await isFileLike(fullPath, entry))) continue;
    const skill = await loadBuiltinSkillFromFile(fullPath);
    if (skill) skills.push(skill);
  }
}

async function loadBuiltinSkillFromFile(filePath: string): Promise<SparkBuiltinSkill | undefined> {
  const raw = await readFile(filePath, "utf8");
  const { frontmatter, body } = parseSkillFrontmatter(raw);
  const description = stringField(frontmatter.description);
  if (!description) return undefined;
  const baseDir = dirname(filePath);
  return {
    name: stringField(frontmatter.name) ?? basename(baseDir).toLowerCase(),
    description,
    filePath,
    baseDir,
    disabled: frontmatter.disabled === true,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    frontmatter,
    body,
  };
}

async function loadBasePromptFile(filePath: string): Promise<SparkBuiltinSkill | undefined> {
  try {
    const body = await readFile(filePath, "utf8");
    const baseDir = dirname(filePath);
    return {
      name: basename(baseDir).toLowerCase(),
      description: `Base system prompt from ${basename(filePath)}`,
      filePath,
      baseDir,
      disabled: false,
      disableModelInvocation: true,
      frontmatter: {},
      body,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function parseSimpleYaml(raw: string): SparkSkillFrontmatter {
  const out: SparkSkillFrontmatter = {};
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const parsedLine = parseYamlLine(line);
    if (!parsedLine) continue;
    const scalar = parsedLine.rest.trim();
    if (scalar === "|" || scalar === ">") {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (next.trim().length > 0 && !/^\s/u.test(next)) break;
        index += 1;
        block.push(next.replace(/^\s+/u, ""));
      }
      out[parsedLine.key] = (scalar === ">" ? block.join(" ") : block.join("\n")).trim();
      continue;
    }
    out[parsedLine.key] = parseYamlScalar(scalar);
  }
  return out;
}

function parseYamlLine(line: string): { key: string; rest: string } | undefined {
  const colonIndex = line.indexOf(":");
  if (colonIndex <= 0) return undefined;
  const key = line.slice(0, colonIndex);
  if (!isYamlKey(key)) return undefined;
  return { key, rest: line.slice(colonIndex + 1) };
}

function isYamlKey(value: string): boolean {
  const first = value[0];
  if (!first || !isYamlKeyStart(first)) return false;
  for (const char of value.slice(1)) if (!isYamlKeyChar(char)) return false;
  return true;
}

function isYamlKeyStart(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

function isYamlKeyChar(char: string): boolean {
  return isYamlKeyStart(char) || (char >= "0" && char <= "9") || char === "-";
}

function parseYamlScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return unquoteYaml(value);
}

function unquoteYaml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
