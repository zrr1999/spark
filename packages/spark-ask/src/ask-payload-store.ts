import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  validatePiAskFlowRequest,
  type PiAskFlowAnswerEntry,
  type PiAskFlowRequest,
  type PiAskFlowResult,
} from "./schema.ts";

export interface StoredAskPayload {
  request: PiAskFlowRequest;
  result: PiAskFlowResult;
  timestamp: number;
}

export class PiAskFlowPayloadStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid Pi ask flow payload store: ${filePath}: ${message}`);
    this.name = "PiAskFlowPayloadStoreFormatError";
    this.filePath = filePath;
  }
}

export class PiAskFlowPayloadStore {
  /** Save the latest ask payload for the given cwd. */
  async save(cwd: string, payload: StoredAskPayload): Promise<void> {
    await writeJsonFileAtomic(askPayloadPath(cwd), payload);
  }

  /** Load the latest ask payload for the given cwd. */
  async load(cwd: string): Promise<StoredAskPayload | null> {
    const filePath = askPayloadPath(cwd);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return parseStoredAskPayload(raw, filePath);
  }
}

function askPayloadPath(cwd: string): string {
  return join(cwd, ".pi", "asks", "latest.json");
}

function parseStoredAskPayload(text: string, filePath: string): StoredAskPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PiAskFlowPayloadStoreFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertStoredAskPayload(raw, filePath);
  return raw;
}

function assertStoredAskPayload(
  value: unknown,
  filePath: string,
): asserts value is StoredAskPayload {
  if (!isRecord(value)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "JSON root must be an object");
  }
  assertPiAskFlowRequestShape(value.request, filePath);
  const validation = validatePiAskFlowRequest(value.request);
  if (!validation.valid) {
    throw new PiAskFlowPayloadStoreFormatError(
      filePath,
      `request is invalid: ${validation.error}${validation.details ? ` (${validation.details})` : ""}`,
    );
  }
  assertPiAskFlowResult(value.result, filePath);
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "timestamp must be a finite number");
  }
}

function assertPiAskFlowRequestShape(
  value: unknown,
  filePath: string,
): asserts value is PiAskFlowRequest {
  if (!isRecord(value)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "request must be an object");
  }
  if (!Array.isArray(value.questions)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "request.questions must be an array");
  }
  value.questions.forEach((question, index) => {
    if (!isRecord(question)) {
      throw new PiAskFlowPayloadStoreFormatError(
        filePath,
        `request.questions[${index}] must be an object`,
      );
    }
    if (question.options !== undefined && !Array.isArray(question.options)) {
      throw new PiAskFlowPayloadStoreFormatError(
        filePath,
        `request.questions[${index}].options must be an array`,
      );
    }
    if (question.defaultValues !== undefined && !isStringArray(question.defaultValues)) {
      throw new PiAskFlowPayloadStoreFormatError(
        filePath,
        `request.questions[${index}].defaultValues must be a string array`,
      );
    }
  });
}

function assertPiAskFlowResult(value: unknown, filePath: string): asserts value is PiAskFlowResult {
  if (!isRecord(value)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "result must be an object");
  }
  if (!isPiAskFlowResultStatus(value.status)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "result.status must be valid");
  }
  if (!isPiAskFlowResultMode(value.mode)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "result.mode must be valid");
  }
  if (typeof value.cancelled !== "boolean") {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "result.cancelled must be a boolean");
  }
  if (!isRecord(value.answers)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "result.answers must be an object");
  }
  for (const [questionId, answer] of Object.entries(value.answers)) {
    assertPiAskFlowAnswerEntry(answer, filePath, `result.answers.${questionId}`);
  }
  if (value.flow !== undefined && typeof value.flow !== "string") {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "result.flow must be a string");
  }
  if (value.nextAction !== undefined && !isPiAskFlowNextAction(value.nextAction)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, "result.nextAction must be valid");
  }
}

function assertPiAskFlowAnswerEntry(
  value: unknown,
  filePath: string,
  path: string,
): asserts value is PiAskFlowAnswerEntry {
  if (!isRecord(value)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path} must be an object`);
  }
  if (typeof value.questionId !== "string" || !value.questionId) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path}.questionId must be a string`);
  }
  if (!isPiAskFlowAnswerKind(value.kind)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path}.kind must be valid`);
  }
  if (!isStringArray(value.values)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path}.values must be a string array`);
  }
  if (value.labels !== undefined && !isStringArray(value.labels)) {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path}.labels must be a string array`);
  }
  if (value.customText !== undefined && typeof value.customText !== "string") {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path}.customText must be a string`);
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path}.notes must be a string`);
  }
  if (value.preview !== undefined && typeof value.preview !== "string") {
    throw new PiAskFlowPayloadStoreFormatError(filePath, `${path}.preview must be a string`);
  }
}

function isPiAskFlowResultStatus(value: unknown): value is PiAskFlowResult["status"] {
  return value === "answered" || value === "cancelled" || value === "no_selection";
}

function isPiAskFlowResultMode(value: unknown): value is PiAskFlowResult["mode"] {
  return value === "submit" || value === "elaborate" || value === "cancel";
}

function isPiAskFlowNextAction(
  value: unknown,
): value is NonNullable<PiAskFlowResult["nextAction"]> {
  return value === "resume" || value === "clarify_then_reask" || value === "block";
}

function isPiAskFlowAnswerKind(value: unknown): value is PiAskFlowAnswerEntry["kind"] {
  return value === "option" || value === "custom" || value === "multi" || value === "skipped";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await cleanupAtomicWriteTempFile(tempPath, error);
    throw error;
  }
}

async function cleanupAtomicWriteTempFile(tempPath: string, writeError: unknown): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch (cleanupError) {
    throw new Error(
      `atomic write failed and temporary file cleanup also failed: ${tempPath}; write error: ${unknownErrorMessage(writeError)}; cleanup error: ${unknownErrorMessage(cleanupError)}`,
    );
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
