import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@zendev-lab/spark-core";
import {
  validateSparkAskFlowRequest,
  type SparkAskFlowAnswerEntry,
  type SparkAskFlowRequest,
  type SparkAskFlowResult,
} from "./schema.ts";

export interface StoredAskPayload {
  request: SparkAskFlowRequest;
  result: SparkAskFlowResult;
  timestamp: number;
}

export class SparkAskFlowPayloadStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid Pi ask flow payload store: ${filePath}: ${message}`);
    this.name = "SparkAskFlowPayloadStoreFormatError";
    this.filePath = filePath;
  }
}

export class SparkAskFlowPayloadStore {
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
  return join(cwd, ".spark", "asks", "latest.json");
}

function parseStoredAskPayload(text: string, filePath: string): StoredAskPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SparkAskFlowPayloadStoreFormatError(
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
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "JSON root must be an object");
  }
  assertSparkAskFlowRequestShape(value.request, filePath);
  const validation = validateSparkAskFlowRequest(value.request);
  if (!validation.valid) {
    throw new SparkAskFlowPayloadStoreFormatError(
      filePath,
      `request is invalid: ${validation.error}${validation.details ? ` (${validation.details})` : ""}`,
    );
  }
  assertSparkAskFlowResult(value.result, filePath);
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "timestamp must be a finite number");
  }
}

function assertSparkAskFlowRequestShape(
  value: unknown,
  filePath: string,
): asserts value is SparkAskFlowRequest {
  if (!isRecord(value)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "request must be an object");
  }
  if (!Array.isArray(value.questions)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "request.questions must be an array");
  }
  value.questions.forEach((question, index) => {
    if (!isRecord(question)) {
      throw new SparkAskFlowPayloadStoreFormatError(
        filePath,
        `request.questions[${index}] must be an object`,
      );
    }
    if (question.options !== undefined && !Array.isArray(question.options)) {
      throw new SparkAskFlowPayloadStoreFormatError(
        filePath,
        `request.questions[${index}].options must be an array`,
      );
    }
    if (question.defaultValues !== undefined && !isStringArray(question.defaultValues)) {
      throw new SparkAskFlowPayloadStoreFormatError(
        filePath,
        `request.questions[${index}].defaultValues must be a string array`,
      );
    }
  });
}

function assertSparkAskFlowResult(
  value: unknown,
  filePath: string,
): asserts value is SparkAskFlowResult {
  if (!isRecord(value)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "result must be an object");
  }
  if (!isSparkAskFlowResultStatus(value.status)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "result.status must be valid");
  }
  if (!isSparkAskFlowResultMode(value.mode)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "result.mode must be valid");
  }
  if (typeof value.cancelled !== "boolean") {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "result.cancelled must be a boolean");
  }
  if (!isRecord(value.answers)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "result.answers must be an object");
  }
  for (const [questionId, answer] of Object.entries(value.answers)) {
    assertSparkAskFlowAnswerEntry(answer, filePath, `result.answers.${questionId}`);
  }
  if (value.flow !== undefined && typeof value.flow !== "string") {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "result.flow must be a string");
  }
  if (value.nextAction !== undefined && !isSparkAskFlowNextAction(value.nextAction)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, "result.nextAction must be valid");
  }
}

function assertSparkAskFlowAnswerEntry(
  value: unknown,
  filePath: string,
  path: string,
): asserts value is SparkAskFlowAnswerEntry {
  if (!isRecord(value)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, `${path} must be an object`);
  }
  if (typeof value.questionId !== "string" || !value.questionId) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, `${path}.questionId must be a string`);
  }
  if (!isSparkAskFlowAnswerKind(value.kind)) {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, `${path}.kind must be valid`);
  }
  if (!isStringArray(value.values)) {
    throw new SparkAskFlowPayloadStoreFormatError(
      filePath,
      `${path}.values must be a string array`,
    );
  }
  if (value.labels !== undefined && !isStringArray(value.labels)) {
    throw new SparkAskFlowPayloadStoreFormatError(
      filePath,
      `${path}.labels must be a string array`,
    );
  }
  if (value.customText !== undefined && typeof value.customText !== "string") {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, `${path}.customText must be a string`);
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, `${path}.notes must be a string`);
  }
  if (value.preview !== undefined && typeof value.preview !== "string") {
    throw new SparkAskFlowPayloadStoreFormatError(filePath, `${path}.preview must be a string`);
  }
}

function isSparkAskFlowResultStatus(value: unknown): value is SparkAskFlowResult["status"] {
  return (
    value === "answered" || value === "pending" || value === "cancelled" || value === "no_selection"
  );
}

function isSparkAskFlowResultMode(value: unknown): value is SparkAskFlowResult["mode"] {
  return value === "submit" || value === "elaborate" || value === "cancel";
}

function isSparkAskFlowNextAction(
  value: unknown,
): value is NonNullable<SparkAskFlowResult["nextAction"]> {
  return value === "resume" || value === "clarify_then_reask" || value === "block";
}

function isSparkAskFlowAnswerKind(value: unknown): value is SparkAskFlowAnswerEntry["kind"] {
  return value === "option" || value === "custom" || value === "multi" || value === "skipped";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
