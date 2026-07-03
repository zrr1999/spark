import {
  readJsonFileOptional as readCoreJsonFileOptional,
  writeJsonFileAtomic as writeCoreJsonFileAtomic,
} from "@zendev-lab/spark-extension-api";

export class JsonStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`Invalid JSON store ${filePath}: ${message}`);
    this.name = "JsonStoreFormatError";
    this.filePath = filePath;
  }
}

export async function readJsonFileOptional<T extends Record<string, unknown>>(
  filePath: string,
): Promise<T | undefined> {
  const raw = await readCoreJsonFileOptional(
    filePath,
    (path, message) => new JsonStoreFormatError(path, message),
  );
  if (raw === undefined) return undefined;
  if (!isJsonObject(raw)) throw new JsonStoreFormatError(filePath, "JSON root must be an object");
  return raw as T;
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeCoreJsonFileAtomic(filePath, value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
