import type { WorkflowMeta } from "./types.ts";

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  body: string;
}

/** @deprecated Spark-named alias kept for compatibility. Prefer ParsedWorkflowScript. */
export type ParsedSparkWorkflowScript = ParsedWorkflowScript;

export function parseWorkflowScript(script: string): ParsedWorkflowScript {
  const marker = "export const meta";
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0) throw new Error("Workflow script must export literal meta");
  const equalsIndex = script.indexOf("=", markerIndex + marker.length);
  if (equalsIndex < 0) throw new Error("Workflow script must assign literal meta");
  const objectStart = script.indexOf("{", equalsIndex);
  if (objectStart < 0) throw new Error("Workflow script meta must be an object literal");
  const objectEnd = findBalancedObjectEnd(script, objectStart);
  const meta = parseMetaLiteral(script.slice(objectStart, objectEnd + 1));
  let afterMeta = script.slice(objectEnd + 1).trimStart();
  if (afterMeta.startsWith(";")) afterMeta = afterMeta.slice(1).trimStart();
  return { meta, body: afterMeta };
}

function findBalancedObjectEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new Error("Workflow meta object is not balanced");
}

/** @deprecated Spark-named alias kept for compatibility. Prefer parseWorkflowScript. */
export const parseSparkWorkflowScript = parseWorkflowScript;

export function parseMetaLiteral(source: string): WorkflowMeta {
  try {
    return normalizeWorkflowMeta(new WorkflowMetaLiteralParser(source).parse());
  } catch (error) {
    throw new Error(
      "Invalid workflow meta literal: " + (error instanceof Error ? error.message : String(error)),
    );
  }
}

class WorkflowMetaLiteralParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): unknown {
    const value = this.parseValue();
    this.skipIgnored();
    if (!this.isDone()) throw this.error("unexpected token");
    return value;
  }

  private parseValue(): unknown {
    this.skipIgnored();
    const char = this.peek();
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === "'" || char === '"') return this.parseString(char);
    if (char === "-" || isDigit(char)) return this.parseNumber();
    return this.parseKeyword();
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const value: Record<string, unknown> = {};
    this.skipIgnored();
    while (this.peek() !== "}") {
      const key = this.parseKey();
      this.skipIgnored();
      this.expect(":");
      value[key] = this.parseValue();
      this.skipIgnored();
      if (this.peek() !== ",") break;
      this.index++;
      this.skipIgnored();
    }
    this.expect("}");
    return value;
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const value: unknown[] = [];
    this.skipIgnored();
    while (this.peek() !== "]") {
      value.push(this.parseValue());
      this.skipIgnored();
      if (this.peek() !== ",") break;
      this.index++;
      this.skipIgnored();
    }
    this.expect("]");
    return value;
  }

  private parseKey(): string {
    this.skipIgnored();
    const char = this.peek();
    if (char === "'" || char === '"') return this.parseString(char);
    return this.parseIdentifier();
  }

  private parseString(quote: string): string {
    this.expect(quote);
    let value = "";
    while (!this.isDone()) {
      const char = this.source[this.index++];
      if (char === quote) return value;
      if (char !== "\\") {
        value += char;
        continue;
      }
      value += this.parseEscapeSequence();
    }
    throw this.error("unterminated string literal");
  }

  private parseEscapeSequence(): string {
    const char = this.source[this.index++];
    if (char === "b") return "\b";
    if (char === "f") return "\f";
    if (char === "n") return "\n";
    if (char === "r") return "\r";
    if (char === "t") return "\t";
    if (char === "v") return "\v";
    if (char === "0") return "\0";
    if (char === "u") return this.parseUnicodeEscape();
    if (char === "x") return this.parseHexEscape();
    if (char === undefined) throw this.error("unterminated escape sequence");
    return char;
  }

  private parseUnicodeEscape(): string {
    const hex = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw this.error("invalid unicode escape");
    this.index += 4;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  private parseHexEscape(): string {
    const hex = this.source.slice(this.index, this.index + 2);
    if (!/^[0-9a-fA-F]{2}$/u.test(hex)) throw this.error("invalid hex escape");
    this.index += 2;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.peek() === "-") this.index++;
    while (isDigit(this.peek())) this.index++;
    if (this.peek() === ".") {
      this.index++;
      while (isDigit(this.peek())) this.index++;
    }
    const exponent = this.peek();
    if (exponent === "e" || exponent === "E") {
      this.index++;
      const sign = this.peek();
      if (sign === "+" || sign === "-") this.index++;
      while (isDigit(this.peek())) this.index++;
    }
    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value)) throw this.error("invalid number literal");
    return value;
  }

  private parseKeyword(): unknown {
    const identifier = this.parseIdentifier();
    if (identifier === "true") return true;
    if (identifier === "false") return false;
    if (identifier === "null") return null;
    if (identifier === "undefined") return undefined;
    throw this.error("unsupported identifier " + identifier);
  }

  private parseIdentifier(): string {
    const match = /^[A-Za-z_$][\w$]*/u.exec(this.source.slice(this.index));
    if (!match) throw this.error("expected identifier");
    this.index += match[0].length;
    return match[0];
  }

  private skipIgnored(): void {
    while (!this.isDone()) {
      const char = this.peek();
      const next = this.source[this.index + 1];
      if (isWhitespace(char)) {
        this.index++;
      } else if (char === "/" && next === "/") {
        this.index = skipLineComment(this.source, this.index + 2) + 1;
      } else if (char === "/" && next === "*") {
        this.index = skipBlockComment(this.source, this.index + 2) + 1;
      } else {
        return;
      }
    }
  }

  private expect(char: string): void {
    if (this.peek() !== char) throw this.error("expected " + char);
    this.index++;
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private isDone(): boolean {
    return this.index >= this.source.length;
  }

  private error(message: string): Error {
    return new Error(message + " at offset " + this.index);
  }
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline < 0 ? source.length - 1 : newline;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start);
  if (end < 0) throw new Error("Workflow meta block comment is not terminated");
  return end + 1;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f";
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

export function normalizeWorkflowMeta(value: unknown): WorkflowMeta {
  if (!value || typeof value !== "object") throw new Error("workflow meta must be an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim())
    throw new Error("workflow meta.name must be a non-empty string");
  if (typeof raw.description !== "string" || !raw.description.trim())
    throw new Error("workflow meta.description must be a non-empty string");
  const meta: WorkflowMeta = { name: raw.name.trim(), description: raw.description.trim() };
  if (typeof raw.whenToUse === "string" && raw.whenToUse.trim())
    meta.whenToUse = raw.whenToUse.trim();
  if (raw.phases !== undefined) {
    if (!Array.isArray(raw.phases)) throw new Error("workflow meta.phases must be an array");
    meta.phases = Array.from(raw.phases).map((phase, index) => {
      if (!phase || typeof phase !== "object")
        throw new Error("workflow meta.phases[" + index + "] must be an object");
      const candidate = phase as Record<string, unknown>;
      if (typeof candidate.title !== "string" || !candidate.title.trim())
        throw new Error("workflow meta.phases[" + index + "].title must be a non-empty string");
      return {
        title: candidate.title.trim(),
        ...(typeof candidate.detail === "string" && candidate.detail.trim()
          ? { detail: candidate.detail.trim() }
          : {}),
        ...(typeof candidate.model === "string" && candidate.model.trim()
          ? { model: candidate.model.trim() }
          : {}),
      };
    });
  }
  return meta;
}

/** @deprecated Spark-named alias kept for compatibility. Prefer normalizeWorkflowMeta. */
export const normalizeSparkWorkflowMeta = normalizeWorkflowMeta;
