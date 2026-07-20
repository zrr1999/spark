/** Spark-native prompt template discovery and expansion. */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

import { parseSkillFrontmatter } from "./skill-resolver.ts";

export type SparkPromptTemplateLayer = "user" | "workspace" | "configured";

export interface SparkPromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  filePath: string;
  baseDir: string;
  layer: SparkPromptTemplateLayer;
}

export interface SparkPromptTemplateDiagnostic {
  type: "warning" | "collision";
  message: string;
  path?: string;
  winnerPath?: string;
  loserPath?: string;
}

export interface SparkPromptTemplateResolverOptions {
  cwd: string;
  sparkHome?: string;
  workspaceDir?: string;
  userDir?: string;
  promptTemplatePaths?: string[];
  includeDefaults?: boolean;
}

export interface SparkPromptTemplateResolveResult {
  templates: SparkPromptTemplate[];
  diagnostics: SparkPromptTemplateDiagnostic[];
}

export interface SparkPromptTemplateExpansion {
  template: SparkPromptTemplate;
  args: string[];
  expanded: string;
}

export class SparkPromptTemplateResolver {
  readonly cwd: string;
  readonly workspaceDir: string;
  readonly userDir: string;
  readonly configuredPaths: string[];
  readonly includeDefaults: boolean;

  constructor(options: SparkPromptTemplateResolverOptions) {
    this.cwd = resolve(options.cwd);
    this.workspaceDir = resolvePath(
      options.workspaceDir ?? join(this.cwd, ".spark", "prompts"),
      this.cwd,
    );
    this.userDir = resolvePath(
      options.userDir ?? defaultSparkPromptTemplatesDir(options.sparkHome),
      this.cwd,
    );
    this.configuredPaths =
      options.promptTemplatePaths?.map((path) => resolvePath(path, this.cwd)) ?? [];
    this.includeDefaults = options.includeDefaults ?? true;
  }

  async resolve(): Promise<SparkPromptTemplateResolveResult> {
    const diagnostics: SparkPromptTemplateDiagnostic[] = [];
    const templatesByName = new Map<string, SparkPromptTemplate>();

    const layers: Array<{ layer: SparkPromptTemplateLayer; paths: string[] }> = [
      ...(this.includeDefaults ? [{ layer: "user" as const, paths: [this.userDir] }] : []),
      ...(this.includeDefaults
        ? [{ layer: "workspace" as const, paths: [this.workspaceDir] }]
        : []),
      { layer: "configured", paths: this.configuredPaths },
    ];

    for (const layer of layers) {
      for (const path of layer.paths) {
        const result = await loadPromptTemplatesFromPath(path, layer.layer, {
          warnOnMissing: layer.layer === "configured",
        });
        diagnostics.push(...result.diagnostics);
        for (const template of result.templates) {
          const existing = templatesByName.get(template.name);
          if (existing) {
            diagnostics.push({
              type: "collision",
              message: `prompt template "/${template.name}" from ${template.layer} overrides ${existing.layer}`,
              path: template.filePath,
              winnerPath: template.filePath,
              loserPath: existing.filePath,
            });
          }
          templatesByName.set(template.name, template);
        }
      }
    }

    return {
      templates: [...templatesByName.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      diagnostics,
    };
  }
}

export function defaultSparkPromptTemplatesRoot(sparkHome?: string): string {
  return resolveSparkUserPaths({ sparkHome }).configRoot;
}

export function defaultSparkPromptTemplatesDir(sparkHome?: string): string {
  return join(defaultSparkPromptTemplatesRoot(sparkHome), "prompts");
}

export async function loadPromptTemplatesFromPath(
  path: string,
  layer: SparkPromptTemplateLayer,
  options: { warnOnMissing?: boolean } = {},
): Promise<SparkPromptTemplateResolveResult> {
  const diagnostics: SparkPromptTemplateDiagnostic[] = [];
  const templates: SparkPromptTemplate[] = [];
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if (options.warnOnMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      diagnostics.push({ type: "warning", message: "Prompt template path does not exist", path });
    } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ type: "warning", message: errorMessage(error), path });
    }
    return { templates, diagnostics };
  }

  if (stats.isDirectory()) return await loadPromptTemplatesFromDir(path, layer);
  if (stats.isFile() && path.endsWith(".md")) {
    const loaded = await loadPromptTemplateFromFile(path, layer);
    if (loaded.template) templates.push(loaded.template);
    diagnostics.push(...loaded.diagnostics);
    return { templates, diagnostics };
  }

  diagnostics.push({
    type: "warning",
    message: "Prompt template path must be a Markdown file or directory",
    path,
  });
  return { templates, diagnostics };
}

export async function loadPromptTemplatesFromDir(
  dir: string,
  layer: SparkPromptTemplateLayer,
): Promise<SparkPromptTemplateResolveResult> {
  const templates: SparkPromptTemplate[] = [];
  const diagnostics: SparkPromptTemplateDiagnostic[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ type: "warning", message: errorMessage(error), path: dir });
    }
    return { templates, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    if (!(await isFileLike(filePath, entry))) continue;
    const loaded = await loadPromptTemplateFromFile(filePath, layer);
    if (loaded.template) templates.push(loaded.template);
    diagnostics.push(...loaded.diagnostics);
  }

  return {
    templates: templates.sort((left, right) => left.name.localeCompare(right.name)),
    diagnostics,
  };
}

export async function loadPromptTemplateFromFile(
  filePath: string,
  layer: SparkPromptTemplateLayer,
): Promise<{ template?: SparkPromptTemplate; diagnostics: SparkPromptTemplateDiagnostic[] }> {
  const diagnostics: SparkPromptTemplateDiagnostic[] = [];
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return { diagnostics: [{ type: "warning", message: errorMessage(error), path: filePath }] };
  }

  if (hasMalformedFrontmatter(raw)) {
    diagnostics.push({
      type: "warning",
      message: "Malformed prompt template frontmatter; treating file as plain Markdown",
      path: filePath,
    });
  }
  const { frontmatter, body } = parseSkillFrontmatter(raw);
  if (frontmatter.disabled === true) {
    diagnostics.push({
      type: "warning",
      message: "Prompt template disabled by frontmatter",
      path: filePath,
    });
    return { diagnostics };
  }
  const name = normalizeTemplateName(basename(filePath).replace(/\.md$/iu, ""));
  if (!name) {
    diagnostics.push({
      type: "warning",
      message: "Prompt template filename must contain a slash-command-safe name",
      path: filePath,
    });
    return { diagnostics };
  }

  const description =
    stringField(frontmatter.description) ?? firstNonEmptyLineDescription(body) ?? "Prompt template";
  const argumentHint = stringField(frontmatter["argument-hint"]);
  return {
    template: {
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      content: body,
      filePath,
      baseDir: dirname(filePath),
      layer,
    },
    diagnostics,
  };
}

export function parseSparkPromptTemplateArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: "'" | '"' | undefined;
  for (let index = 0; index < argsString.length; index++) {
    const char = argsString[index];
    if (inQuote) {
      if (char === inQuote) inQuote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

export function substituteSparkPromptTemplateArgs(
  content: string,
  args: readonly string[],
): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
    (_match, defaultNum, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultNum) {
        const index = Number.parseInt(defaultNum, 10) - 1;
        const value = args[index];
        return value ? value : defaultValue;
      }
      if (sliceStart) {
        let start = Number.parseInt(sliceStart, 10) - 1;
        if (start < 0) start = 0;
        if (sliceLength) {
          const length = Number.parseInt(sliceLength, 10);
          return args.slice(start, start + length).join(" ");
        }
        return args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      const index = Number.parseInt(simple, 10) - 1;
      return args[index] ?? "";
    },
  );
}

export function expandSparkPromptTemplate(
  text: string,
  templates: readonly SparkPromptTemplate[],
): SparkPromptTemplateExpansion | undefined {
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match?.[1]) return undefined;
  const templateName = normalizeTemplateName(match[1]);
  if (!templateName) return undefined;
  const template = templates.find((item) => item.name === templateName);
  if (!template) return undefined;
  const args = parseSparkPromptTemplateArgs(match[2] ?? "");
  return {
    template,
    args,
    expanded: substituteSparkPromptTemplateArgs(template.content, args),
  };
}

function hasMalformedFrontmatter(markdown: string): boolean {
  return markdown.startsWith("---\n") && markdown.indexOf("\n---", 4) < 0;
}

function firstNonEmptyLineDescription(body: string): string | undefined {
  const line = body.split(/\r?\n/u).find((entry) => entry.trim());
  if (!line) return undefined;
  return line.length > 60 ? `${line.slice(0, 60)}...` : line;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTemplateName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) return undefined;
  return normalized;
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

function resolvePath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
