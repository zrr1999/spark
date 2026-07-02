import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { AskConfig, AskConfigStore } from "./schema.ts";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions");
const CONFIG_FILE = join(CONFIG_DIR, "spark-ask.json");

export interface AskConfigStoreOptions {
  filePath?: string;
}

export class AskConfigStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid Pi ask config store: ${filePath}: ${message}`);
    this.name = "AskConfigStoreFormatError";
    this.filePath = filePath;
  }
}

export function createAskConfigStore(options: AskConfigStoreOptions = {}): AskConfigStore {
  const filePath = options.filePath ?? CONFIG_FILE;
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return getDefaultConfig();
        throw error;
      }
      return parseAskConfig(text, filePath);
    },
    save(config: AskConfig) {
      assertAskConfig(config, filePath);
      writeConfigFileAtomic(filePath, config);
    },
  };
}

export function getDefaultConfig(): AskConfig {
  return { schemaVersion: 1 };
}

function parseAskConfig(text: string, filePath: string): AskConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AskConfigStoreFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return migrateConfig(raw, filePath);
}

function migrateConfig(raw: unknown, filePath: string): AskConfig {
  if (!isRecord(raw)) {
    throw new AskConfigStoreFormatError(filePath, "JSON root must be an object");
  }
  if (raw.schemaVersion === undefined) {
    return getDefaultConfig();
  }
  assertAskConfig(raw, filePath);
  return raw;
}

function assertAskConfig(value: unknown, filePath: string): asserts value is AskConfig {
  if (!isRecord(value)) {
    throw new AskConfigStoreFormatError(filePath, "config must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new AskConfigStoreFormatError(filePath, "schemaVersion must be 1");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function writeConfigFileAtomic(filePath: string, config: AskConfig): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    cleanupAtomicConfigTempFile(tempPath, error);
    throw error;
  }
}

function cleanupAtomicConfigTempFile(tempPath: string, writeError: unknown): void {
  try {
    rmSync(tempPath, { force: true });
  } catch (cleanupError) {
    throw new Error(
      `atomic config write failed and temporary file cleanup also failed: ${tempPath}; write error: ${unknownErrorMessage(writeError)}; cleanup error: ${unknownErrorMessage(cleanupError)}`,
    );
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
