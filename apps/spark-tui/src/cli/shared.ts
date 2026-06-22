/** Small shared helpers for the native Spark TUI command surface. */

export interface SparkCliOutput {
  write(text: string): void;
}

export const consoleSparkCliOutput: SparkCliOutput = {
  write(text) {
    console.log(text);
  },
};

export interface ParsedSparkCliOptions {
  options: Record<string, string | boolean>;
  positionals: string[];
}

export function parseSparkCliOptions(argv: string[]): ParsedSparkCliOptions {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.replace(/^-+/, "").split("=", 2);
    const name = normalizeOptionName(rawName ?? "");
    if (!name) throw new Error(`invalid option: ${arg}`);
    if (inlineValue !== undefined) {
      options[name] = inlineValue;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }

  return { options, positionals };
}

export function readStringOption(
  options: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = options[name];
  if (value === undefined || value === false) return undefined;
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

export function readBooleanOption(
  options: Record<string, string | boolean>,
  name: string,
): boolean {
  return options[name] === true;
}

export function readNumberOption(
  options: Record<string, string | boolean>,
  name: string,
): number | undefined {
  const raw = readStringOption(options, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

export function printSparkCliResult(
  output: SparkCliOutput,
  value: unknown,
  options: { json?: boolean } = {},
): void {
  if (options.json) {
    output.write(JSON.stringify(value, null, 2));
    return;
  }
  output.write(formatSparkCliHuman(value));
}

export function formatSparkCliHuman(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.description ?? "";
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
  if (Array.isArray(value)) return value.map(formatSparkCliHuman).join("\n");
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (typeof entry === "object" && entry !== null) {
      lines.push(`${key}: ${JSON.stringify(entry)}`);
    } else {
      lines.push(`${key}: ${formatSparkCliHuman(entry)}`);
    }
  }
  return lines.join("\n");
}

const BOOLEAN_OPTIONS = new Set(["help", "json", "once", "reset"]);

function normalizeOptionName(name: string): string {
  switch (name) {
    case "p":
      return "prompt";
    case "s":
      return "session";
    case "h":
      return "help";
    default:
      return name;
  }
}
