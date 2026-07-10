/** Exact runtime validators for cue-core's server-to-client IPC payloads. */

import { Buffer } from "node:buffer";

type WireRecord = Record<string, unknown>;
type Validator = (value: unknown, path: string) => void;

const JOB_STATUS_VARIANTS = new Set(["Pending", "Running", "Done", "Failed", "Killed"]);
const CANCEL_REASON_VARIANTS = new Set(["User", "ChainAborted", "Timeout"]);
const CRON_STATUS_VARIANTS = new Set(["scheduled", "paused", "completed", "expired", "failed"]);
const OPEN_HINT_VARIANTS = new Set(["stream", "fg"]);
const SCRIPT_RUN_STATUS_VARIANTS = new Set(["done", "failed"]);
const SCRIPT_INFO_STATUS_VARIANTS = new Set(["running", "done", "failed"]);
const STREAM_VARIANTS = new Set(["stdout", "stderr"]);
const OUTPUT_ENCODING_VARIANTS = new Set(["utf8", "base64"]);
const COMPLETION_KIND_VARIANTS = new Set(["Command", "Param", "Id", "Path", "Operator"]);
const HIGHLIGHT_KIND_VARIANTS = new Set([
  "CommandPrefix",
  "CommandName",
  "ModeParam",
  "Operator",
  "IdRef",
  "Word",
  "String",
  "Number",
  "Error",
]);

export function validateCueOkPayload<T>(value: T, path = "response.payload.Ok"): T {
  const [variant, body] = singleVariant(value, path);
  switch (variant) {
    case "Ack":
      exactRecord(body, `${path}.Ack`, []);
      break;
    case "ScriptCreated":
      validateScriptCreated(body, `${path}.ScriptCreated`);
      break;
    case "ScriptInfo":
      validateScriptInfo(body, `${path}.ScriptInfo`);
      break;
    case "JobCreated":
      validateJobCreatedResponse(body, `${path}.JobCreated`);
      break;
    case "ChainCreated":
      validateChainCreated(body, `${path}.ChainCreated`);
      break;
    case "CronAdded":
      validateSingleStringField(body, `${path}.CronAdded`, "cron_id");
      break;
    case "ScopeCreated":
      validateScopeCreated(body, `${path}.ScopeCreated`);
      break;
    case "JobInfo":
      validateJobInfo(body, `${path}.JobInfo`);
      break;
    case "JobList":
      validateArray(body, `${path}.JobList`, validateJobInfo);
      break;
    case "JobListPage":
      validateListPage(body, `${path}.JobListPage`, "jobs", validateJobInfo);
      break;
    case "CronList":
      validateArray(body, `${path}.CronList`, validateCronInfo);
      break;
    case "CronListPage":
      validateListPage(body, `${path}.CronListPage`, "crons", validateCronInfo);
      break;
    case "ScopeInfo":
      validateScopeInfo(body, `${path}.ScopeInfo`);
      break;
    case "ScopeList":
      validateArray(body, `${path}.ScopeList`, validateScopeInfo);
      break;
    case "ScopeListPage":
      validateListPage(body, `${path}.ScopeListPage`, "scopes", validateScopeInfo);
      break;
    case "Output":
      validateOutput(body, `${path}.Output`);
      break;
    case "JobOutput":
      validateJobOutput(body, `${path}.JobOutput`);
      break;
    case "EvalText":
      validateSingleStringField(body, `${path}.EvalText`, "text");
      break;
    case "TextOutput":
      validateTextOutput(body, `${path}.TextOutput`);
      break;
    case "CompletionList":
      validateCompletionList(body, `${path}.CompletionList`);
      break;
    case "HighlightResult":
      validateHighlightResult(body, `${path}.HighlightResult`);
      break;
    case "FgAttached":
      validateSingleStringField(body, `${path}.FgAttached`, "id");
      break;
    case "Pong":
      validatePong(body, `${path}.Pong`);
      break;
    default:
      throw invalidIpc(path, `unknown protocol variant ${variant}`);
  }
  return value;
}

export function validateCueEventPayload<T>(value: T, path = "event.payload"): T {
  const [variant, body] = singleVariant(value, path);
  switch (variant) {
    case "JobStateChanged":
      validateJobStateChanged(body, `${path}.JobStateChanged`);
      break;
    case "JobCreated":
      validateJobCreatedEvent(body, `${path}.JobCreated`);
      break;
    case "ChainProgress":
      validateChainProgress(body, `${path}.ChainProgress`);
      break;
    case "ScriptItemCreated":
      validateScriptItemCreated(body, `${path}.ScriptItemCreated`);
      break;
    case "ScriptFinished":
      validateScriptFinished(body, `${path}.ScriptFinished`);
      break;
    case "JobRemoved":
      validateSingleStringField(body, `${path}.JobRemoved`, "job_id");
      break;
    case "CronTriggered":
      validateCronTriggered(body, `${path}.CronTriggered`);
      break;
    case "CronRemoved":
      validateSingleStringField(body, `${path}.CronRemoved`, "cron_id");
      break;
    case "OutputChunk":
      validateOutputChunk(body, `${path}.OutputChunk`);
      break;
    case "OutputChunkBinary":
      validateOutputChunkBinary(body, `${path}.OutputChunkBinary`);
      break;
    case "OutputEof":
      validateSingleStringField(body, `${path}.OutputEof`, "id");
      break;
    case "FgOutput":
      validateFgOutput(body, `${path}.FgOutput`);
      break;
    case "FgExited":
      validateFgExited(body, `${path}.FgExited`);
      break;
    case "ShuttingDown":
      validateSingleStringField(body, `${path}.ShuttingDown`, "reason");
      break;
    default:
      throw invalidIpc(path, `unknown protocol variant ${variant}`);
  }
  return value;
}

export function validateCueErrorPayload<T>(value: T, path = "response.payload.Err"): T {
  const record = exactRecord(value, path, ["code", "message"]);
  stringField(record, "code", path);
  stringField(record, "message", path);
  return value;
}

function validateScriptCreated(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["script_id", "source", "items", "submit_error"]);
  stringField(record, "script_id", path);
  validateScriptSource(record.source, `${path}.source`);
  validateArray(record.items, `${path}.items`, validateScriptItemInfo);
  nullable(record.submit_error, `${path}.submit_error`, validateScriptSubmitError);
}

function validateScriptInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "script_id",
    "status",
    "items",
    "exit_code",
    "failed_item_index",
    "submit_error",
  ]);
  stringField(record, "script_id", path);
  enumField(record, "status", path, SCRIPT_INFO_STATUS_VARIANTS);
  validateArray(record.items, `${path}.items`, validateScriptItemInfo);
  nullable(record.exit_code, `${path}.exit_code`, validateI32);
  nullableUsizeField(record, "failed_item_index", path);
  nullable(record.submit_error, `${path}.submit_error`, validateScriptSubmitError);
}

function validateJobCreatedResponse(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "job_id",
    "start_scope",
    "open_hint",
    "chain_id",
    "chain_index",
    "chain_total",
    "warnings",
  ]);
  stringField(record, "job_id", path);
  nullableStringField(record, "start_scope", path);
  openHintField(record, "open_hint", path);
  nullableStringField(record, "chain_id", path);
  nullableUsizeField(record, "chain_index", path);
  nullableUsizeField(record, "chain_total", path);
  stringArrayField(record, "warnings", path);
}

function validateChainCreated(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["chain_id", "job_ids", "chain", "warnings"]);
  stringField(record, "chain_id", path);
  stringArrayField(record, "job_ids", path);
  validateChainInfo(record.chain, `${path}.chain`);
  stringArrayField(record, "warnings", path);
}

function validateScopeCreated(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["hash", "summary"]);
  stringField(record, "hash", path);
  stringField(record, "summary", path);
}

function validateJobInfo(value: unknown, path: string): void {
  const record = exactRecord(
    value,
    path,
    [
      "id",
      "status",
      "pipeline",
      "exit_code",
      "start_scope",
      "end_scope",
      "open_hint",
      "chain_id",
      "chain_index",
      "chain_total",
    ],
    ["pending_reason"],
  );
  stringField(record, "id", path);
  validateJobStatus(record.status, `${path}.status`);
  stringField(record, "pipeline", path);
  nullable(record.exit_code, `${path}.exit_code`, validateI32);
  nullableStringField(record, "start_scope", path);
  nullableStringField(record, "end_scope", path);
  openHintField(record, "open_hint", path);
  nullableStringField(record, "chain_id", path);
  nullableUsizeField(record, "chain_index", path);
  nullableUsizeField(record, "chain_total", path);
  if ("pending_reason" in record) stringField(record, "pending_reason", path);
}

function validateCronInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "schedule", "command", "status"]);
  stringField(record, "id", path);
  stringField(record, "schedule", path);
  stringField(record, "command", path);
  enumField(record, "status", path, CRON_STATUS_VARIANTS);
}

function validateScopeInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["hash", "parent", "cwd", "env_count"]);
  stringField(record, "hash", path);
  nullableStringField(record, "parent", path);
  stringField(record, "cwd", path);
  usizeField(record, "env_count", path);
}

function validateChainInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "pipeline", "total_jobs", "jobs"]);
  stringField(record, "id", path);
  stringField(record, "pipeline", path);
  usizeField(record, "total_jobs", path);
  validateArray(record.jobs, `${path}.jobs`, validateChainJobInfo);
}

function validateChainJobInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "index",
    "pipeline",
    "status",
    "job_id",
    "start_scope",
    "end_scope",
    "open_hint",
  ]);
  usizeField(record, "index", path);
  stringField(record, "pipeline", path);
  validateJobStatus(record.status, `${path}.status`);
  nullableStringField(record, "job_id", path);
  nullableStringField(record, "start_scope", path);
  nullableStringField(record, "end_scope", path);
  nullable(record.open_hint, `${path}.open_hint`, validateOpenHint);
}

function validateScriptItemInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["index", "source", "result"]);
  usizeField(record, "index", path);
  stringField(record, "source", path);
  validateScriptItemResult(record.result, `${path}.result`);
}

function validateScriptSource(value: unknown, path: string): void {
  const record = recordValue(value, path);
  if (!Object.hasOwn(record, "kind")) throw invalidIpc(`${path}.kind`, "missing field kind");
  const kind = stringField(record, "kind", path);
  if (kind === "inline") {
    exactRecord(record, path, ["kind"]);
    return;
  }
  if (kind === "file") {
    const file = exactRecord(record, path, ["kind", "path"]);
    stringField(file, "path", path);
    return;
  }
  throw invalidIpc(`${path}.kind`, `unknown script source ${kind}`);
}

function validateScriptItemResult(value: unknown, path: string): void {
  const record = recordValue(value, path);
  if (!Object.hasOwn(record, "kind")) throw invalidIpc(`${path}.kind`, "missing field kind");
  const kind = stringField(record, "kind", path);
  switch (kind) {
    case "job": {
      const job = exactRecord(record, path, ["kind", "job_id", "start_scope", "open_hint"]);
      stringField(job, "job_id", path);
      nullableStringField(job, "start_scope", path);
      openHintField(job, "open_hint", path);
      return;
    }
    case "chain": {
      const chain = exactRecord(record, path, ["kind", "chain_id", "job_ids", "chain"]);
      stringField(chain, "chain_id", path);
      stringArrayField(chain, "job_ids", path);
      validateChainInfo(chain.chain, `${path}.chain`);
      return;
    }
    case "cron": {
      const cron = exactRecord(record, path, ["kind", "cron_id"]);
      stringField(cron, "cron_id", path);
      return;
    }
    case "message": {
      const message = exactRecord(record, path, ["kind", "text"]);
      stringField(message, "text", path);
      return;
    }
    default:
      throw invalidIpc(`${path}.kind`, `unknown script item result ${kind}`);
  }
}

function validateScriptSubmitError(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["index", "source", "code", "message"]);
  usizeField(record, "index", path);
  stringField(record, "source", path);
  stringField(record, "code", path);
  stringField(record, "message", path);
}

function validatePageInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["total", "shown", "limit", "truncated"]);
  usizeField(record, "total", path);
  usizeField(record, "shown", path);
  nullableUsizeField(record, "limit", path);
  booleanField(record, "truncated", path);
}

function validateListPage(
  value: unknown,
  path: string,
  listKey: "jobs" | "crons" | "scopes",
  itemValidator: Validator,
): void {
  const record = exactRecord(value, path, [listKey, "page"]);
  validateArray(record[listKey], `${path}.${listKey}`, itemValidator);
  validatePageInfo(record.page, `${path}.page`);
}

function validateOutput(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "data", "truncated"], ["encoding", "base64"]);
  stringField(record, "id", path);
  stringField(record, "data", path);
  booleanField(record, "truncated", path);
  validateOutputEncoding(record, path);
}

function validateTextOutput(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["text", "truncated"], ["encoding", "base64"]);
  stringField(record, "text", path);
  booleanField(record, "truncated", path);
  validateOutputEncoding(record, path);
}

function validateStreamText(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["data", "truncated"], ["encoding", "base64"]);
  stringField(record, "data", path);
  booleanField(record, "truncated", path);
  validateOutputEncoding(record, path);
}

function validateOutputEncoding(record: WireRecord, path: string): void {
  const encoding =
    "encoding" in record ? enumField(record, "encoding", path, OUTPUT_ENCODING_VARIANTS) : "utf8";
  if (encoding === "base64") {
    if (!("base64" in record)) throw invalidIpc(`${path}.base64`, "missing field base64");
    validateCanonicalBase64(record.base64, `${path}.base64`);
    return;
  }
  if ("base64" in record) {
    throw invalidIpc(`${path}.base64`, "base64 is only valid when encoding is base64");
  }
}

function validateJobOutput(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "stdout", "stderr", "stderr_pty_merged"]);
  stringField(record, "id", path);
  validateStreamText(record.stdout, `${path}.stdout`);
  validateStreamText(record.stderr, `${path}.stderr`);
  booleanField(record, "stderr_pty_merged", path);
}

function validateCompletionList(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["items"]);
  validateArray(record.items, `${path}.items`, validateCompletionItem);
}

function validateCompletionItem(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["label", "insert_text", "kind", "detail"]);
  stringField(record, "label", path);
  stringField(record, "insert_text", path);
  enumField(record, "kind", path, COMPLETION_KIND_VARIANTS);
  nullableStringField(record, "detail", path);
}

function validateHighlightResult(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["spans"]);
  validateArray(record.spans, `${path}.spans`, validateHighlightSpan);
}

function validateHighlightSpan(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["start", "end", "kind"]);
  usizeField(record, "start", path);
  usizeField(record, "end", path);
  enumField(record, "kind", path, HIGHLIGHT_KIND_VARIANTS);
}

function validatePong(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "version",
    "protocol_version",
    "capabilities",
    "instance_id",
  ]);
  stringField(record, "version", path);
  u32Field(record, "protocol_version", path);
  stringArrayField(record, "capabilities", path);
  stringField(record, "instance_id", path);
}

function validateJobStateChanged(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "job_id",
    "old_state",
    "new_state",
    "end_scope",
    "chain_id",
    "chain_index",
  ]);
  stringField(record, "job_id", path);
  validateJobStatus(record.old_state, `${path}.old_state`);
  validateJobStatus(record.new_state, `${path}.new_state`);
  nullableStringField(record, "end_scope", path);
  nullableStringField(record, "chain_id", path);
  nullableUsizeField(record, "chain_index", path);
}

function validateJobCreatedEvent(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "job_id",
    "pipeline",
    "start_scope",
    "open_hint",
    "chain_id",
    "chain_index",
    "chain_total",
  ]);
  stringField(record, "job_id", path);
  stringField(record, "pipeline", path);
  nullableStringField(record, "start_scope", path);
  openHintField(record, "open_hint", path);
  nullableStringField(record, "chain_id", path);
  nullableUsizeField(record, "chain_index", path);
  nullableUsizeField(record, "chain_total", path);
}

function validateChainProgress(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["chain"]);
  validateChainInfo(record.chain, `${path}.chain`);
}

function validateScriptItemCreated(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["script_id", "item"]);
  stringField(record, "script_id", path);
  validateScriptItemInfo(record.item, `${path}.item`);
}

function validateScriptFinished(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "script_id",
    "status",
    "exit_code",
    "failed_item_index",
  ]);
  stringField(record, "script_id", path);
  enumField(record, "status", path, SCRIPT_RUN_STATUS_VARIANTS);
  validateI32(record.exit_code, `${path}.exit_code`);
  nullableUsizeField(record, "failed_item_index", path);
}

function validateCronTriggered(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["cron_id", "job_id"]);
  stringField(record, "cron_id", path);
  stringField(record, "job_id", path);
}

function validateOutputChunk(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "stream", "data"]);
  stringField(record, "id", path);
  enumField(record, "stream", path, STREAM_VARIANTS);
  stringField(record, "data", path);
}

function validateOutputChunkBinary(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "stream", "base64"]);
  stringField(record, "id", path);
  enumField(record, "stream", path, STREAM_VARIANTS);
  validateCanonicalBase64(record.base64, `${path}.base64`);
}

function validateFgOutput(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["data"]);
  validateCanonicalBase64(record.data, `${path}.data`);
}

function validateFgExited(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "reason"]);
  stringField(record, "id", path);
  stringField(record, "reason", path);
}

function validateSingleStringField(value: unknown, path: string, key: string): void {
  const record = exactRecord(value, path, [key]);
  stringField(record, key, path);
}

function validateJobStatus(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (JOB_STATUS_VARIANTS.has(value)) return;
    throw invalidIpc(path, `unknown job status ${value}`);
  }
  const record = exactRecord(value, path, ["Cancelled"]);
  enumField(record, "Cancelled", path, CANCEL_REASON_VARIANTS);
}

function validateOpenHint(value: unknown, path: string): void {
  validateEnum(value, path, OPEN_HINT_VARIANTS);
}

function validateCanonicalBase64(value: unknown, path: string): void {
  if (typeof value !== "string") throw invalidIpc(path, "expected a base64 string");
  const canonical = Buffer.from(value, "base64").toString("base64");
  if (canonical !== value) throw invalidIpc(path, "expected canonical base64");
}

function validateArray(value: unknown, path: string, validator: Validator): void {
  if (!Array.isArray(value)) throw invalidIpc(path, "expected an array");
  value.forEach((item, index) => validator(item, `${path}[${index}]`));
}

function nullable(value: unknown, path: string, validator: Validator): void {
  if (value !== null) validator(value, path);
}

function validateEnum(value: unknown, path: string, variants: ReadonlySet<string>): string {
  if (typeof value !== "string" || !variants.has(value)) {
    throw invalidIpc(path, `expected one of ${[...variants].join(", ")}`);
  }
  return value;
}

function stringField(record: WireRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw invalidIpc(`${path}.${key}`, "expected a string");
  return value;
}

function nullableStringField(record: WireRecord, key: string, path: string): void {
  nullable(record[key], `${path}.${key}`, validateString);
}

function stringArrayField(record: WireRecord, key: string, path: string): void {
  validateArray(record[key], `${path}.${key}`, validateString);
}

function booleanField(record: WireRecord, key: string, path: string): void {
  if (typeof record[key] !== "boolean") throw invalidIpc(`${path}.${key}`, "expected a boolean");
}

function usizeField(record: WireRecord, key: string, path: string): void {
  validateUsize(record[key], `${path}.${key}`);
}

function nullableUsizeField(record: WireRecord, key: string, path: string): void {
  nullable(record[key], `${path}.${key}`, validateUsize);
}

function u32Field(record: WireRecord, key: string, path: string): void {
  validateInteger(record[key], `${path}.${key}`, 0, 0xffff_ffff);
}

function openHintField(record: WireRecord, key: string, path: string): void {
  validateOpenHint(record[key], `${path}.${key}`);
}

function enumField(
  record: WireRecord,
  key: string,
  path: string,
  variants: ReadonlySet<string>,
): string {
  return validateEnum(record[key], `${path}.${key}`, variants);
}

function validateString(value: unknown, path: string): void {
  if (typeof value !== "string") throw invalidIpc(path, "expected a string");
}

function validateUsize(value: unknown, path: string): void {
  validateInteger(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function validateI32(value: unknown, path: string): void {
  validateInteger(value, path, -0x8000_0000, 0x7fff_ffff);
}

function validateInteger(value: unknown, path: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalidIpc(path, `expected an integer from ${min} to ${max}`);
  }
}

function exactRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): WireRecord {
  const record = recordValue(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidIpc(path, `unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw invalidIpc(`${path}.${key}`, `missing field ${key}`);
  }
  return record;
}

function recordValue(value: unknown, path: string): WireRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIpc(path, "expected an object");
  }
  return value as WireRecord;
}

function singleVariant(value: unknown, path: string): [string, unknown] {
  const record = recordValue(value, path);
  const keys = Object.keys(record);
  if (keys.length !== 1) throw invalidIpc(path, "expected exactly one protocol variant");
  const variant = keys[0]!;
  return [variant, record[variant]];
}

function invalidIpc(path: string, message: string): Error {
  return new Error(`invalid cue-shell IPC message at ${path}: ${message}`);
}
