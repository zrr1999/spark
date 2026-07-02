export type SparkUiJsonPrimitive = string | number | boolean | null;
export type SparkUiJsonValue =
  | SparkUiJsonPrimitive
  | SparkUiJsonValue[]
  | { [key: string]: SparkUiJsonValue };
export type SparkUiJsonObject = { [key: string]: SparkUiJsonValue };

export type SparkUiSourceFormat = "mdx-lite";
export type SparkUiDiagnosticSeverity = "warning" | "error";

export interface SparkUiDiagnostic {
  code:
    | "dangerous_html"
    | "dangerous_url"
    | "expression_not_allowed"
    | "incomplete_component"
    | "invalid_component"
    | "invalid_props"
    | "unknown_component"
    | "unsupported_statement";
  severity: SparkUiDiagnosticSeverity;
  message: string;
  line?: number;
  source?: string;
}

export interface SparkUiMarkdownBlock {
  type: "markdown";
  text: string;
}

export interface SparkUiComponentBlock {
  type: "component";
  name: string;
  props: SparkUiJsonObject;
  source?: string;
}

export interface SparkUiArtifactBlock {
  type: "artifact";
  artifactRef: string;
  variant?: "card" | "inline";
  title?: string;
}

export interface SparkUiTaskBlock {
  type: "task";
  taskRef: string;
  variant?: "status" | "summary";
  title?: string;
}

export interface SparkUiRunBlock {
  type: "run";
  runRef: string;
  variant?: "timeline" | "summary";
  title?: string;
}

export interface SparkUiCalloutBlock {
  type: "callout";
  tone: "info" | "success" | "warning" | "error";
  title?: string;
  body: string;
}

export type SparkUiBlock =
  | SparkUiMarkdownBlock
  | SparkUiComponentBlock
  | SparkUiArtifactBlock
  | SparkUiTaskBlock
  | SparkUiRunBlock
  | SparkUiCalloutBlock;

export interface SparkUiDocumentV1 {
  schemaVersion: 1;
  sourceFormat: SparkUiSourceFormat;
  blocks: SparkUiBlock[];
  diagnostics: SparkUiDiagnostic[];
}

export type SparkUiComponentKind = "component" | "artifact" | "task" | "run" | "callout";

export interface SparkUiComponentDefinition {
  name: string;
  kind: SparkUiComponentKind;
  requiredProps?: string[];
  allowedProps?: string[];
}

export type SparkUiComponentCatalog = ReadonlyMap<string, SparkUiComponentDefinition>;

export interface ParseSparkUiOptions {
  catalog?: SparkUiComponentCatalog;
  sourceFormat?: SparkUiSourceFormat;
}

export const defaultSparkUiComponentDefinitions = [
  {
    name: "ArtifactCard",
    kind: "artifact",
    requiredProps: ["artifactRef"],
    allowedProps: ["artifactRef", "variant", "title"],
  },
  {
    name: "ArtifactLink",
    kind: "artifact",
    requiredProps: ["artifactRef"],
    allowedProps: ["artifactRef", "variant", "title"],
  },
  {
    name: "TaskStatus",
    kind: "task",
    requiredProps: ["taskRef"],
    allowedProps: ["taskRef", "variant", "title"],
  },
  {
    name: "TaskSummary",
    kind: "task",
    requiredProps: ["taskRef"],
    allowedProps: ["taskRef", "variant", "title"],
  },
  {
    name: "RunTimeline",
    kind: "run",
    requiredProps: ["runRef"],
    allowedProps: ["runRef", "variant", "title"],
  },
  {
    name: "RunSummary",
    kind: "run",
    requiredProps: ["runRef"],
    allowedProps: ["runRef", "variant", "title"],
  },
  {
    name: "Callout",
    kind: "callout",
    allowedProps: ["tone", "type", "title"],
  },
] as const satisfies SparkUiComponentDefinition[];

export const defaultSparkUiComponentCatalog = createSparkUiComponentCatalog(
  defaultSparkUiComponentDefinitions,
);

export function createSparkUiComponentCatalog(
  definitions: readonly SparkUiComponentDefinition[],
): SparkUiComponentCatalog {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

export function parseSparkUiSource(
  source: string,
  options: ParseSparkUiOptions = {},
): SparkUiDocumentV1 {
  const catalog = options.catalog ?? defaultSparkUiComponentCatalog;
  const diagnostics: SparkUiDiagnostic[] = [];
  const blocks: SparkUiBlock[] = [];
  const markdownBuffer: string[] = [];
  const lines = source.split(/\r?\n/);

  function flushMarkdown(): void {
    const text = trimMarkdownBuffer(markdownBuffer);
    markdownBuffer.length = 0;
    if (text) blocks.push({ type: "markdown", text });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const trimmed = line.trim();

    const unsupportedStatement = unsupportedStatementDiagnostic(trimmed, lineNumber);
    if (unsupportedStatement) {
      diagnostics.push(unsupportedStatement);
      markdownBuffer.push(line);
      continue;
    }

    if (isDangerousHtml(trimmed)) {
      diagnostics.push({
        code: "dangerous_html",
        severity: "error",
        message: "Raw script/style/iframe HTML is not rendered as Spark UI.",
        line: lineNumber,
        source: line,
      });
      markdownBuffer.push(line);
      continue;
    }

    const calloutStart = trimmed.match(/^<Callout\b([^>]*)>\s*$/u);
    if (calloutStart) {
      const collected = collectClosingTag(lines, index + 1, "Callout");
      if (!collected) {
        diagnostics.push({
          code: "incomplete_component",
          severity: "warning",
          message: "Incomplete <Callout> block; rendering source as Markdown until it closes.",
          line: lineNumber,
          source: line,
        });
        markdownBuffer.push(line);
        continue;
      }

      const sourceBlock = [line, ...collected.bodyLines, lines[collected.endIndex] ?? ""].join(
        "\n",
      );
      const parsed = componentBlockFromSource({
        name: "Callout",
        attrSource: calloutStart[1] ?? "",
        body: collected.bodyLines.join("\n"),
        line: lineNumber,
        source: sourceBlock,
        catalog,
      });
      if (parsed.block) {
        flushMarkdown();
        blocks.push(parsed.block);
      } else {
        markdownBuffer.push(sourceBlock);
      }
      diagnostics.push(...parsed.diagnostics);
      index = collected.endIndex;
      continue;
    }

    const selfClosing = trimmed.match(/^<([A-Z][A-Za-z0-9]*)\b([^>]*)\/>\s*$/u);
    if (selfClosing) {
      const parsed = componentBlockFromSource({
        name: selfClosing[1] ?? "",
        attrSource: selfClosing[2] ?? "",
        line: lineNumber,
        source: line,
        catalog,
      });
      if (parsed.block) {
        flushMarkdown();
        blocks.push(parsed.block);
      } else {
        markdownBuffer.push(line);
      }
      diagnostics.push(...parsed.diagnostics);
      continue;
    }

    if (/^<[A-Z][A-Za-z0-9]*/u.test(trimmed) && !trimmed.includes(">")) {
      diagnostics.push({
        code: "incomplete_component",
        severity: "warning",
        message: "Incomplete component tag; rendering source as Markdown until the tag closes.",
        line: lineNumber,
        source: line,
      });
      markdownBuffer.push(line);
      continue;
    }

    markdownBuffer.push(line);
  }

  flushMarkdown();

  return {
    schemaVersion: 1,
    sourceFormat: options.sourceFormat ?? "mdx-lite",
    blocks,
    diagnostics,
  };
}

function componentBlockFromSource(input: {
  name: string;
  attrSource: string;
  body?: string;
  line: number;
  source: string;
  catalog: SparkUiComponentCatalog;
}): { block?: SparkUiBlock; diagnostics: SparkUiDiagnostic[] } {
  const diagnostics: SparkUiDiagnostic[] = [];
  const definition = input.catalog.get(input.name);
  if (!definition) {
    diagnostics.push({
      code: "unknown_component",
      severity: "warning",
      message: `Unknown Spark UI component <${input.name}>; rendering source as Markdown.`,
      line: input.line,
      source: input.source,
    });
    return { diagnostics };
  }

  const parsedProps = parseAttributes(input.attrSource, input.line, input.source);
  diagnostics.push(...parsedProps.diagnostics);
  if (!parsedProps.ok) return { diagnostics };

  const propValidation = validateProps(definition, parsedProps.props, input.line, input.source);
  diagnostics.push(...propValidation);
  if (propValidation.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }

  const block = blockFromDefinition(definition, parsedProps.props, input.body, input.source);
  return block ? { block, diagnostics } : { diagnostics };
}

function blockFromDefinition(
  definition: SparkUiComponentDefinition,
  props: SparkUiJsonObject,
  body: string | undefined,
  source: string,
): SparkUiBlock | undefined {
  if (definition.kind === "artifact") {
    const artifactRef = stringProp(props, "artifactRef");
    if (!artifactRef) return undefined;
    return {
      type: "artifact",
      artifactRef,
      variant: artifactVariant(props),
      title: stringProp(props, "title"),
    };
  }

  if (definition.kind === "task") {
    const taskRef = stringProp(props, "taskRef");
    if (!taskRef) return undefined;
    return {
      type: "task",
      taskRef,
      variant: taskVariant(props),
      title: stringProp(props, "title"),
    };
  }

  if (definition.kind === "run") {
    const runRef = stringProp(props, "runRef");
    if (!runRef) return undefined;
    return {
      type: "run",
      runRef,
      variant: runVariant(props),
      title: stringProp(props, "title"),
    };
  }

  if (definition.kind === "callout") {
    return {
      type: "callout",
      tone: calloutTone(props),
      title: stringProp(props, "title"),
      body: body?.trim() ?? "",
    };
  }

  return {
    type: "component",
    name: definition.name,
    props,
    source,
  };
}

function parseAttributes(
  source: string,
  line: number,
  originalSource: string,
):
  | { ok: true; props: SparkUiJsonObject; diagnostics: SparkUiDiagnostic[] }
  | { ok: false; diagnostics: SparkUiDiagnostic[] } {
  const diagnostics: SparkUiDiagnostic[] = [];
  const props: SparkUiJsonObject = {};
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;

    const match = source
      .slice(cursor)
      .match(/^([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"']+))?/u);
    if (!match) {
      diagnostics.push({
        code: source.slice(cursor).includes("{") ? "expression_not_allowed" : "invalid_props",
        severity: "error",
        message: "Only quoted string and bare boolean props are allowed in Spark UI components.",
        line,
        source: originalSource,
      });
      return { ok: false, diagnostics };
    }

    const key = match[1] ?? "";
    const rawValue = match[2];
    cursor += match[0].length;

    if (key.toLowerCase().startsWith("on")) {
      diagnostics.push({
        code: "invalid_props",
        severity: "error",
        message: `Event handler prop ${key} is not allowed in Spark UI components.`,
        line,
        source: originalSource,
      });
      return { ok: false, diagnostics };
    }

    const value = rawValue === undefined ? true : parseAttributeValue(rawValue);
    if (value === undefined) {
      diagnostics.push({
        code: rawValue?.includes("{") ? "expression_not_allowed" : "invalid_props",
        severity: "error",
        message: `Prop ${key} must be a quoted string or bare boolean literal.`,
        line,
        source: originalSource,
      });
      return { ok: false, diagnostics };
    }

    if (typeof value === "string" && isDangerousUrlProp(key, value)) {
      diagnostics.push({
        code: "dangerous_url",
        severity: "error",
        message: `Dangerous URL value is not allowed for prop ${key}.`,
        line,
        source: originalSource,
      });
      return { ok: false, diagnostics };
    }

    props[key] = value;
  }

  return { ok: true, props, diagnostics };
}

function parseAttributeValue(rawValue: string): string | undefined {
  if (rawValue.startsWith("{") || rawValue.includes("}")) return undefined;
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return undefined;
}

function validateProps(
  definition: SparkUiComponentDefinition,
  props: SparkUiJsonObject,
  line: number,
  source: string,
): SparkUiDiagnostic[] {
  const diagnostics: SparkUiDiagnostic[] = [];
  const allowed = new Set(definition.allowedProps ?? []);
  const required = definition.requiredProps ?? [];

  for (const key of required) {
    if (!(key in props)) {
      diagnostics.push({
        code: "invalid_props",
        severity: "error",
        message: `<${definition.name}> requires prop ${key}.`,
        line,
        source,
      });
    }
  }

  if (allowed.size > 0) {
    for (const key of Object.keys(props)) {
      if (!allowed.has(key)) {
        diagnostics.push({
          code: "invalid_props",
          severity: "error",
          message: `<${definition.name}> does not allow prop ${key}.`,
          line,
          source,
        });
      }
    }
  }

  if (
    definition.kind === "artifact" &&
    !stringProp(props, "artifactRef")?.startsWith("artifact:")
  ) {
    diagnostics.push({
      code: "invalid_props",
      severity: "error",
      message: "artifactRef must be an artifact: ref.",
      line,
      source,
    });
  }
  if (definition.kind === "task" && !stringProp(props, "taskRef")?.startsWith("task:")) {
    diagnostics.push({
      code: "invalid_props",
      severity: "error",
      message: "taskRef must be a task: ref.",
      line,
      source,
    });
  }
  if (definition.kind === "run" && !stringProp(props, "runRef")?.startsWith("run:")) {
    diagnostics.push({
      code: "invalid_props",
      severity: "error",
      message: "runRef must be a run: ref.",
      line,
      source,
    });
  }

  return diagnostics;
}

function collectClosingTag(
  lines: string[],
  startIndex: number,
  tagName: string,
): { bodyLines: string[]; endIndex: number } | null {
  const bodyLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === `</${tagName}>`) {
      return { bodyLines, endIndex: index };
    }
    bodyLines.push(line);
  }
  return null;
}

function unsupportedStatementDiagnostic(trimmed: string, line: number): SparkUiDiagnostic | null {
  if (/^(import|export)\b/u.test(trimmed)) {
    return {
      code: "unsupported_statement",
      severity: "error",
      message: "Import/export statements are not executed in Spark UI source.",
      line,
      source: trimmed,
    };
  }

  if (/\{[^}]+\}/u.test(trimmed)) {
    return {
      code: "expression_not_allowed",
      severity: "error",
      message: "JavaScript expressions are not executed in Spark UI source.",
      line,
      source: trimmed,
    };
  }

  return null;
}

function trimMarkdownBuffer(lines: string[]): string {
  return lines.join("\n").replace(/^\n+/u, "").replace(/\n+$/u, "");
}

function stringProp(props: SparkUiJsonObject, key: string): string | undefined {
  const value = props[key];
  return typeof value === "string" ? value : undefined;
}

function artifactVariant(props: SparkUiJsonObject): SparkUiArtifactBlock["variant"] {
  const value = stringProp(props, "variant");
  return value === "inline" ? "inline" : "card";
}

function taskVariant(props: SparkUiJsonObject): SparkUiTaskBlock["variant"] {
  const value = stringProp(props, "variant");
  return value === "summary" ? "summary" : "status";
}

function runVariant(props: SparkUiJsonObject): SparkUiRunBlock["variant"] {
  const value = stringProp(props, "variant");
  return value === "summary" ? "summary" : "timeline";
}

function calloutTone(props: SparkUiJsonObject): SparkUiCalloutBlock["tone"] {
  const value = stringProp(props, "tone") ?? stringProp(props, "type");
  if (value === "success" || value === "warning" || value === "error") return value;
  return "info";
}

function isDangerousHtml(value: string): boolean {
  return /^<(script|style|iframe)\b/iu.test(value);
}

function isDangerousUrlProp(key: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("javascript:")) return false;
  const lowerKey = key.toLowerCase();
  return (
    lowerKey === "href" ||
    lowerKey === "src" ||
    lowerKey.endsWith("url") ||
    lowerKey.endsWith("href") ||
    lowerKey.endsWith("src")
  );
}
