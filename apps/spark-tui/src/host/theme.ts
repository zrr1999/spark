import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { MarkdownTheme } from "../tui/pi-tui-adapter.ts";
import type { SparkHostRenderTheme } from "./types.ts";

export interface SparkThemeColors {
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  user: string;
  assistant: string;
  system: string;
  tool: string;
  thinking: string;
  custom: string;
  markdownHeading: string;
  markdownCode: string;
  markdownQuote: string;
  diffAdd: string;
  diffRemove: string;
  diffHunk: string;
}

export interface SparkTheme {
  id: string;
  label: string;
  mode: "dark" | "light";
  colors: SparkThemeColors;
}

export interface SparkThemeDiagnostic {
  type: "warning" | "error";
  message: string;
}

export interface SparkThemeCatalog {
  themes: SparkTheme[];
  active: SparkTheme;
  diagnostics: SparkThemeDiagnostic[];
}

export interface SparkThemeLoadOptions {
  cwd: string;
  sparkHome?: string;
  configuredThemePaths?: string[];
  activeThemeId?: string;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const STRIKETHROUGH = "\x1b[9m";

export const BUILTIN_SPARK_THEMES: readonly SparkTheme[] = [
  {
    id: "dark",
    label: "Spark Dark",
    mode: "dark",
    colors: {
      foreground: "#d4d4d8",
      muted: "#8b949e",
      border: "#52525b",
      accent: "#7dd3fc",
      success: "#86efac",
      warning: "#fde68a",
      error: "#fca5a5",
      user: "#a5b4fc",
      assistant: "#7dd3fc",
      system: "#d4d4d8",
      tool: "#c4b5fd",
      thinking: "#f0abfc",
      custom: "#f9a8d4",
      markdownHeading: "#f8fafc",
      markdownCode: "#fde68a",
      markdownQuote: "#94a3b8",
      diffAdd: "#86efac",
      diffRemove: "#fca5a5",
      diffHunk: "#93c5fd",
    },
  },
  {
    id: "light",
    label: "Spark Light",
    mode: "light",
    colors: {
      foreground: "#18181b",
      muted: "#71717a",
      border: "#a1a1aa",
      accent: "#0369a1",
      success: "#15803d",
      warning: "#a16207",
      error: "#b91c1c",
      user: "#4338ca",
      assistant: "#0369a1",
      system: "#18181b",
      tool: "#6d28d9",
      thinking: "#a21caf",
      custom: "#be185d",
      markdownHeading: "#111827",
      markdownCode: "#92400e",
      markdownQuote: "#475569",
      diffAdd: "#15803d",
      diffRemove: "#b91c1c",
      diffHunk: "#1d4ed8",
    },
  },
] as const;

export const DEFAULT_SPARK_THEME_ID = "dark";

export async function loadSparkThemeCatalog(
  options: SparkThemeLoadOptions,
): Promise<SparkThemeCatalog> {
  const diagnostics: SparkThemeDiagnostic[] = [];
  const byId = new Map<string, SparkTheme>(BUILTIN_SPARK_THEMES.map((theme) => [theme.id, theme]));
  const files = await discoverThemeFiles(options, diagnostics);
  for (const file of files) {
    try {
      const theme = parseSparkTheme(JSON.parse(await readFile(file, "utf8")), file);
      byId.set(theme.id, theme);
    } catch (error) {
      diagnostics.push({
        type: "warning",
        message: `Skipping theme ${file}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const active =
    byId.get(options.activeThemeId ?? DEFAULT_SPARK_THEME_ID) ?? byId.get(DEFAULT_SPARK_THEME_ID)!;
  if (options.activeThemeId && active.id !== options.activeThemeId) {
    diagnostics.push({
      type: "warning",
      message: `Unknown active Spark theme "${options.activeThemeId}"; using ${active.id}.`,
    });
  }
  return {
    themes: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    active,
    diagnostics,
  };
}

export function createSparkHostRenderTheme(theme: SparkTheme): SparkHostRenderTheme {
  return {
    fg: (color, text) => ansiFg(resolveThemeColor(theme, color), text),
    bg: (color, text) => ansiBg(resolveThemeColor(theme, color), text),
    bold: (text) => `${BOLD}${text}${RESET}`,
    strikethrough: (text) => `${STRIKETHROUGH}${text}${RESET}`,
  };
}

export function createSparkMarkdownTheme(theme: SparkTheme): MarkdownTheme {
  const renderTheme = createSparkHostRenderTheme(theme);
  return {
    heading: (text) => renderTheme.bold(renderTheme.fg("markdownHeading", text)),
    link: (text) => renderTheme.fg("accent", text),
    linkUrl: (text) => renderTheme.fg("muted", text),
    code: (text) => renderTheme.fg("markdownCode", text),
    codeBlock: (text) => renderTheme.fg("markdownCode", text),
    codeBlockBorder: (text) => renderTheme.fg("border", text),
    quote: (text) => renderTheme.fg("markdownQuote", text),
    quoteBorder: (text) => renderTheme.fg("markdownQuote", text),
    hr: (text) => renderTheme.fg("border", text),
    listBullet: (text) => renderTheme.fg("accent", text),
    bold: (text) => renderTheme.bold(text),
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
    codeBlockIndent: "  ",
  };
}

export function styleSparkDiffLine(theme: SparkTheme, line: string): string {
  const renderTheme = createSparkHostRenderTheme(theme);
  if (line.startsWith("+++") || line.startsWith("---")) return renderTheme.fg("diffHunk", line);
  if (line.startsWith("@@")) return renderTheme.fg("diffHunk", line);
  if (line.startsWith("+")) return renderTheme.fg("diffAdd", line);
  if (line.startsWith("-")) return renderTheme.fg("diffRemove", line);
  return line;
}

export function styleSparkRoleLine(theme: SparkTheme, role: string, line: string): string {
  const renderTheme = createSparkHostRenderTheme(theme);
  switch (role) {
    case "user":
      return renderTheme.fg("user", line);
    case "assistant":
      return renderTheme.fg("assistant", line);
    case "system":
      return renderTheme.fg("system", line);
    case "tool":
      return renderTheme.fg("tool", line);
    case "thinking":
      return renderTheme.fg("thinking", line);
    case "custom":
      return renderTheme.fg("custom", line);
    default:
      return renderTheme.fg("foreground", line);
  }
}

function resolveThemeColor(theme: SparkTheme, color: string): string {
  return (theme.colors as unknown as Record<string, string>)[color] ?? color;
}

function ansiFg(color: string, text: string): string {
  const code = ansiColorCode(color, false);
  return code ? `${code}${text}${RESET}` : text;
}

function ansiBg(color: string, text: string): string {
  const code = ansiColorCode(color, true);
  return code ? `${code}${text}${RESET}` : text;
}

function ansiColorCode(color: string, background: boolean): string | undefined {
  const hex = /^#?([0-9a-f]{6})$/iu.exec(color.trim())?.[1];
  if (!hex) return undefined;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `\x1b[${background ? 48 : 38};2;${r};${g};${b}m`;
}

async function discoverThemeFiles(
  options: SparkThemeLoadOptions,
  diagnostics: SparkThemeDiagnostic[],
): Promise<string[]> {
  const candidates = [
    join(options.sparkHome ?? join(homedir(), ".spark"), "themes"),
    ...(options.configuredThemePaths ?? []).map((entry) => resolveThemePath(entry, options.cwd)),
  ];
  const files: string[] = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) {
        const entries = await readdir(candidate);
        files.push(
          ...entries
            .filter((entry) => entry.endsWith(".json"))
            .sort((left, right) => left.localeCompare(right))
            .map((entry) => join(candidate, entry)),
        );
      } else if (info.isFile()) {
        files.push(candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({
          type: "warning",
          message: `Could not inspect theme path ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  return [...new Set(files.map((file) => resolve(file)))];
}

function resolveThemePath(path: string, cwd: string): string {
  const expanded = path === "~" ? homedir() : path.replace(/^~(?=\/|$)/u, homedir());
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function parseSparkTheme(value: unknown, source: string): SparkTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("theme must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const id = stringField(record.id) ?? stringField(record.name) ?? basename(source, ".json");
  if (!/^[a-zA-Z0-9._-]+$/u.test(id)) throw new Error(`invalid theme id: ${id}`);
  const baseId = record.extends === "light" ? "light" : "dark";
  const base = BUILTIN_SPARK_THEMES.find((theme) => theme.id === baseId)!;
  const colors = parseThemeColors(record.colors, base.colors);
  return {
    id,
    label: stringField(record.label) ?? id,
    mode: record.mode === "light" ? "light" : record.mode === "dark" ? "dark" : base.mode,
    colors,
  };
}

function parseThemeColors(value: unknown, fallback: SparkThemeColors): SparkThemeColors {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const record = value as Record<string, unknown>;
  const colors = { ...fallback };
  for (const key of Object.keys(colors) as Array<keyof SparkThemeColors>) {
    const next = stringField(record[key]);
    if (next) colors[key] = next;
  }
  return colors;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function themeParentDir(path: string): string {
  return dirname(path);
}
