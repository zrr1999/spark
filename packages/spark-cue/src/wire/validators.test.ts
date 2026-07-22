import assert from "node:assert/strict";
import { test } from "vitest";

import {
  validateCueErrorPayload,
  validateCueEventPayload,
  validateCueOkPayload,
} from "./validators.ts";

type Path = Array<string | number>;
type PayloadValidator = (value: unknown) => unknown;

interface SchemaCase {
  name: string;
  canonical: unknown;
  validate: PayloadValidator;
  missing: () => unknown;
  extra: () => unknown;
  wrongType: () => unknown;
}

const page = { total: 1, shown: 1, limit: null, truncated: false };
const chainJob = {
  index: 0,
  pipeline: "echo ok",
  status: "Done",
  job_id: "J1",
  start_scope: null,
  end_scope: "scope-end",
  open_hint: "stream",
};
const chain = {
  id: "CH1",
  pipeline: "echo ok",
  total_jobs: 1,
  jobs: [chainJob],
};
const job = {
  id: "J1",
  status: { Cancelled: "User" },
  pipeline: "echo ok",
  exit_code: -1,
  start_scope: null,
  end_scope: "scope-end",
  open_hint: "stream",
  chain_id: "CH1",
  chain_index: 0,
  chain_total: 1,
  pending_reason: "waiting for resource",
};
const cron = { id: "C1", schedule: "every 1m", command: "echo ok", status: "scheduled" };
const scope = { hash: "scope-1", parent: null, cwd: "/work", env_count: 2 };
const scriptItems = [
  {
    index: 0,
    source: "echo ok",
    result: { kind: "job", job_id: "J1", start_scope: null, open_hint: "stream" },
  },
  {
    index: 1,
    source: "echo one -> echo two",
    result: { kind: "chain", chain_id: "CH1", job_ids: ["J1"], chain },
  },
  { index: 2, source: ":cron every 1m echo ok", result: { kind: "cron", cron_id: "C1" } },
  { index: 3, source: "message", result: { kind: "message", text: "ok" } },
];

const okCases: SchemaCase[] = [
  manualCase("Ack", { Ack: {} }, validateCueOkPayload, {}, { Ack: { extra: true } }, { Ack: [] }),
  objectCase(
    "ScriptCreated",
    {
      ScriptCreated: {
        script_id: "R1",
        source: { kind: "file", path: "build.cue" },
        items: scriptItems,
        submit_error: { index: 4, source: "bad", code: "PARSE", message: "bad item" },
      },
    },
    validateCueOkPayload,
    ["ScriptCreated", "script_id"],
    ["ScriptCreated"],
  ),
  objectCase(
    "JobCreated",
    {
      JobCreated: {
        job_id: "J1",
        start_scope: null,
        open_hint: "stream",
        chain_id: null,
        chain_index: null,
        chain_total: null,
        warnings: [],
      },
    },
    validateCueOkPayload,
    ["JobCreated", "job_id"],
    ["JobCreated"],
  ),
  objectCase(
    "ChainCreated",
    { ChainCreated: { chain_id: "CH1", job_ids: ["J1"], chain, warnings: [] } },
    validateCueOkPayload,
    ["ChainCreated", "chain_id"],
    ["ChainCreated"],
  ),
  objectCase(
    "CronAdded",
    { CronAdded: { cron_id: "C1" } },
    validateCueOkPayload,
    ["CronAdded", "cron_id"],
    ["CronAdded"],
  ),
  objectCase(
    "ScopeCreated",
    { ScopeCreated: { hash: "scope-1", summary: "cwd=/work" } },
    validateCueOkPayload,
    ["ScopeCreated", "hash"],
    ["ScopeCreated"],
  ),
  objectCase("JobInfo", { JobInfo: job }, validateCueOkPayload, ["JobInfo", "id"], ["JobInfo"]),
  arrayCase("JobList", { JobList: [job] }, validateCueOkPayload, ["JobList", 0, "id"]),
  objectCase(
    "JobListPage",
    { JobListPage: { jobs: [job], page } },
    validateCueOkPayload,
    ["JobListPage", "jobs"],
    ["JobListPage"],
  ),
  arrayCase("CronList", { CronList: [cron] }, validateCueOkPayload, ["CronList", 0, "id"]),
  objectCase(
    "CronListPage",
    { CronListPage: { crons: [cron], page } },
    validateCueOkPayload,
    ["CronListPage", "crons"],
    ["CronListPage"],
  ),
  objectCase(
    "ScopeInfo",
    { ScopeInfo: scope },
    validateCueOkPayload,
    ["ScopeInfo", "hash"],
    ["ScopeInfo"],
  ),
  arrayCase("ScopeList", { ScopeList: [scope] }, validateCueOkPayload, ["ScopeList", 0, "hash"]),
  objectCase(
    "ScopeListPage",
    { ScopeListPage: { scopes: [scope], page } },
    validateCueOkPayload,
    ["ScopeListPage", "scopes"],
    ["ScopeListPage"],
  ),
  objectCase(
    "Output",
    { Output: { id: "J1", data: "ok\n", truncated: false, encoding: "utf8" } },
    validateCueOkPayload,
    ["Output", "data"],
    ["Output"],
  ),
  objectCase(
    "JobOutput",
    {
      JobOutput: {
        id: "J1",
        stdout: { data: "ok\n", truncated: false, encoding: "utf8" },
        stderr: { data: "�", truncated: false, encoding: "base64", base64: "/w==" },
        stderr_pty_merged: false,
      },
    },
    validateCueOkPayload,
    ["JobOutput", "id"],
    ["JobOutput"],
  ),
  objectCase(
    "EvalText",
    { EvalText: { text: "ok" } },
    validateCueOkPayload,
    ["EvalText", "text"],
    ["EvalText"],
  ),
  objectCase(
    "TextOutput",
    { TextOutput: { text: "ok", truncated: false, encoding: "utf8" } },
    validateCueOkPayload,
    ["TextOutput", "text"],
    ["TextOutput"],
  ),
  objectCase(
    "CompletionList",
    {
      CompletionList: {
        items: [{ label: ":run", insert_text: ":run", kind: "Command", detail: null }],
      },
    },
    validateCueOkPayload,
    ["CompletionList", "items"],
    ["CompletionList"],
  ),
  objectCase(
    "HighlightResult",
    { HighlightResult: { spans: [{ start: 0, end: 4, kind: "CommandName" }] } },
    validateCueOkPayload,
    ["HighlightResult", "spans"],
    ["HighlightResult"],
  ),
  objectCase(
    "FgAttached",
    { FgAttached: { id: "J1" } },
    validateCueOkPayload,
    ["FgAttached", "id"],
    ["FgAttached"],
  ),
  objectCase(
    "Pong",
    {
      Pong: {
        version: "0.1.0",
        protocol_version: 2,
        capabilities: ["cancel-execution"],
        instance_id: "00000000-0000-4000-8000-000000000001",
        generation_id: "00000000-0000-4000-8000-000000000002",
        ready: true,
      },
    },
    validateCueOkPayload,
    ["Pong", "version"],
    ["Pong"],
  ),
];

const eventCases: SchemaCase[] = [
  objectCase(
    "JobStateChanged",
    {
      JobStateChanged: {
        job_id: "J1",
        old_state: "Running",
        new_state: { Cancelled: "Timeout" },
        end_scope: null,
        chain_id: null,
        chain_index: null,
      },
    },
    validateCueEventPayload,
    ["JobStateChanged", "job_id"],
    ["JobStateChanged"],
  ),
  objectCase(
    "JobCreated event",
    {
      JobCreated: {
        job_id: "J1",
        pipeline: "echo ok",
        start_scope: null,
        open_hint: "stream",
        chain_id: null,
        chain_index: null,
        chain_total: null,
      },
    },
    validateCueEventPayload,
    ["JobCreated", "job_id"],
    ["JobCreated"],
  ),
  objectCase(
    "ChainProgress",
    { ChainProgress: { chain } },
    validateCueEventPayload,
    ["ChainProgress", "chain"],
    ["ChainProgress"],
  ),
  objectCase(
    "ScriptItemCreated",
    { ScriptItemCreated: { script_id: "R1", item: scriptItems[0] } },
    validateCueEventPayload,
    ["ScriptItemCreated", "script_id"],
    ["ScriptItemCreated"],
  ),
  objectCase(
    "ScriptFinished",
    {
      ScriptFinished: { script_id: "R1", status: "done", exit_code: 0, failed_item_index: null },
    },
    validateCueEventPayload,
    ["ScriptFinished", "script_id"],
    ["ScriptFinished"],
  ),
  objectCase(
    "JobRemoved",
    { JobRemoved: { job_id: "J1" } },
    validateCueEventPayload,
    ["JobRemoved", "job_id"],
    ["JobRemoved"],
  ),
  objectCase(
    "CronTriggered",
    { CronTriggered: { cron_id: "C1", job_id: "J1" } },
    validateCueEventPayload,
    ["CronTriggered", "cron_id"],
    ["CronTriggered"],
  ),
  objectCase(
    "CronRemoved",
    { CronRemoved: { cron_id: "C1" } },
    validateCueEventPayload,
    ["CronRemoved", "cron_id"],
    ["CronRemoved"],
  ),
  objectCase(
    "OutputChunk",
    { OutputChunk: { id: "J1", stream: "stdout", data: "ok\n" } },
    validateCueEventPayload,
    ["OutputChunk", "id"],
    ["OutputChunk"],
  ),
  objectCase(
    "OutputChunkBinary",
    { OutputChunkBinary: { id: "J1", stream: "stderr", base64: "/w==" } },
    validateCueEventPayload,
    ["OutputChunkBinary", "id"],
    ["OutputChunkBinary"],
  ),
  objectCase(
    "OutputEof",
    { OutputEof: { id: "J1" } },
    validateCueEventPayload,
    ["OutputEof", "id"],
    ["OutputEof"],
  ),
  objectCase(
    "FgOutput",
    { FgOutput: { data: "b2s=" } },
    validateCueEventPayload,
    ["FgOutput", "data"],
    ["FgOutput"],
  ),
  objectCase(
    "FgExited",
    { FgExited: { id: "J1", reason: "completed" } },
    validateCueEventPayload,
    ["FgExited", "id"],
    ["FgExited"],
  ),
  objectCase(
    "ShuttingDown",
    { ShuttingDown: { reason: "requested" } },
    validateCueEventPayload,
    ["ShuttingDown", "reason"],
    ["ShuttingDown"],
  ),
];

for (const schema of [...okCases, ...eventCases]) {
  test(`cue wire accepts canonical ${schema.name}`, () => {
    assert.doesNotThrow(() => schema.validate(clone(schema.canonical)));
  });

  test(`cue wire rejects missing fields for ${schema.name}`, () => {
    assert.throws(() => schema.validate(schema.missing()), /invalid cue-shell IPC message/);
  });

  test(`cue wire rejects extra fields for ${schema.name}`, () => {
    assert.throws(() => schema.validate(schema.extra()), /unknown field|exactly one/);
  });

  test(`cue wire rejects wrong field types for ${schema.name}`, () => {
    assert.throws(() => schema.validate(schema.wrongType()), /invalid cue-shell IPC message/);
  });
}

const nestedCases: Array<{
  name: string;
  canonical: unknown;
  path: Path;
  required: string;
  wrong: string;
  validate: PayloadValidator;
}> = [
  {
    name: "PageInfo",
    canonical: { JobListPage: { jobs: [job], page } },
    path: ["JobListPage", "page"],
    required: "total",
    wrong: "shown",
    validate: validateCueOkPayload,
  },
  {
    name: "StreamText",
    canonical: {
      JobOutput: {
        id: "J1",
        stdout: { data: "ok", truncated: false, encoding: "utf8" },
        stderr: { data: "", truncated: false, encoding: "utf8" },
        stderr_pty_merged: false,
      },
    },
    path: ["JobOutput", "stdout"],
    required: "data",
    wrong: "truncated",
    validate: validateCueOkPayload,
  },
  {
    name: "ChainInfo",
    canonical: { ChainProgress: { chain } },
    path: ["ChainProgress", "chain"],
    required: "id",
    wrong: "total_jobs",
    validate: validateCueEventPayload,
  },
  {
    name: "ChainJobInfo",
    canonical: { ChainProgress: { chain } },
    path: ["ChainProgress", "chain", "jobs", 0],
    required: "index",
    wrong: "pipeline",
    validate: validateCueEventPayload,
  },
  {
    name: "ScriptItemInfo",
    canonical: { ScriptItemCreated: { script_id: "R1", item: scriptItems[0] } },
    path: ["ScriptItemCreated", "item"],
    required: "index",
    wrong: "source",
    validate: validateCueEventPayload,
  },
  {
    name: "ScriptSource",
    canonical: {
      ScriptCreated: {
        script_id: "R1",
        source: { kind: "file", path: "build.cue" },
        items: [],
        submit_error: null,
      },
    },
    path: ["ScriptCreated", "source"],
    required: "path",
    wrong: "kind",
    validate: validateCueOkPayload,
  },
  {
    name: "ScriptSource inline variant",
    canonical: {
      ScriptCreated: {
        script_id: "R1",
        source: { kind: "inline" },
        items: [],
        submit_error: null,
      },
    },
    path: ["ScriptCreated", "source"],
    required: "kind",
    wrong: "kind",
    validate: validateCueOkPayload,
  },
  {
    name: "ScriptItemResult",
    canonical: { ScriptItemCreated: { script_id: "R1", item: scriptItems[0] } },
    path: ["ScriptItemCreated", "item", "result"],
    required: "job_id",
    wrong: "open_hint",
    validate: validateCueEventPayload,
  },
  {
    name: "ScriptItemResult chain variant",
    canonical: { ScriptItemCreated: { script_id: "R1", item: scriptItems[1] } },
    path: ["ScriptItemCreated", "item", "result"],
    required: "chain_id",
    wrong: "job_ids",
    validate: validateCueEventPayload,
  },
  {
    name: "ScriptItemResult cron variant",
    canonical: { ScriptItemCreated: { script_id: "R1", item: scriptItems[2] } },
    path: ["ScriptItemCreated", "item", "result"],
    required: "cron_id",
    wrong: "cron_id",
    validate: validateCueEventPayload,
  },
  {
    name: "ScriptItemResult message variant",
    canonical: { ScriptItemCreated: { script_id: "R1", item: scriptItems[3] } },
    path: ["ScriptItemCreated", "item", "result"],
    required: "text",
    wrong: "text",
    validate: validateCueEventPayload,
  },
  {
    name: "JobStatus cancelled variant",
    canonical: { JobInfo: job },
    path: ["JobInfo", "status"],
    required: "Cancelled",
    wrong: "Cancelled",
    validate: validateCueOkPayload,
  },
  {
    name: "ScriptSubmitError",
    canonical: {
      ScriptCreated: {
        script_id: "R1",
        source: { kind: "inline" },
        items: [],
        submit_error: { index: 0, source: "bad", code: "PARSE", message: "bad" },
      },
    },
    path: ["ScriptCreated", "submit_error"],
    required: "index",
    wrong: "message",
    validate: validateCueOkPayload,
  },
  {
    name: "CompletionItem",
    canonical: {
      CompletionList: {
        items: [{ label: ":run", insert_text: ":run", kind: "Command", detail: null }],
      },
    },
    path: ["CompletionList", "items", 0],
    required: "label",
    wrong: "kind",
    validate: validateCueOkPayload,
  },
  {
    name: "HighlightSpan",
    canonical: { HighlightResult: { spans: [{ start: 0, end: 4, kind: "CommandName" }] } },
    path: ["HighlightResult", "spans", 0],
    required: "start",
    wrong: "kind",
    validate: validateCueOkPayload,
  },
];

for (const schema of nestedCases) {
  test(`cue wire nested ${schema.name} is exact and typed`, () => {
    assert.doesNotThrow(() => schema.validate(clone(schema.canonical)));
    assert.throws(
      () => schema.validate(deletePath(schema.canonical, [...schema.path, schema.required])),
      /missing field/,
    );
    assert.throws(
      () => schema.validate(setPath(schema.canonical, [...schema.path, "extra"], true)),
      /unknown field extra/,
    );
    assert.throws(
      () => schema.validate(setPath(schema.canonical, [...schema.path, schema.wrong], {})),
      /invalid cue-shell IPC message/,
    );
  });
}

test("cue wire output encoding accepts legacy UTF-8 and canonical base64 only", () => {
  assert.doesNotThrow(() =>
    validateCueOkPayload({ Output: { id: "J1", data: "legacy", truncated: false } }),
  );
  assert.doesNotThrow(() =>
    validateCueOkPayload({
      TextOutput: { text: "�", truncated: false, encoding: "base64", base64: "/w==" },
    }),
  );
  assert.throws(
    () =>
      validateCueOkPayload({
        Output: { id: "J1", data: "bad", truncated: false, encoding: "base64" },
      }),
    /missing field base64/,
  );
  assert.throws(
    () =>
      validateCueOkPayload({
        Output: { id: "J1", data: "bad", truncated: false, encoding: "utf8", base64: "YmFk" },
      }),
    /only valid when encoding is base64/,
  );
  assert.throws(
    () =>
      validateCueEventPayload({
        OutputChunkBinary: { id: "J1", stream: "stdout", base64: "not base64" },
      }),
    /canonical base64/,
  );
});

test("cue wire Pong accepts optional restart generation and readiness compatibly", () => {
  const legacy = {
    Pong: { version: "0.1.0", protocol_version: 2, capabilities: ["cancel-execution"] },
  };
  assert.doesNotThrow(() => validateCueOkPayload(legacy));
  assert.doesNotThrow(() =>
    validateCueOkPayload({
      Pong: {
        ...legacy.Pong,
        generation_id: "00000000-0000-4000-8000-000000000002",
        ready: false,
      },
    }),
  );
  assert.throws(
    () => validateCueOkPayload({ Pong: { ...legacy.Pong, generation_id: 42 } }),
    /generation_id: expected a string/,
  );
  assert.throws(
    () => validateCueOkPayload({ Pong: { ...legacy.Pong, ready: "yes" } }),
    /ready: expected a boolean/,
  );
});

test("cue wire error payload has an exact schema", () => {
  assert.doesNotThrow(() => validateCueErrorPayload({ code: "NOT_FOUND", message: "missing" }));
  assert.throws(() => validateCueErrorPayload({ code: "NOT_FOUND" }), /missing field message/);
  assert.throws(
    () => validateCueErrorPayload({ code: "NOT_FOUND", message: "missing", extra: true }),
    /unknown field extra/,
  );
  assert.throws(
    () => validateCueErrorPayload({ code: 404, message: "missing" }),
    /code: expected a string/,
  );
});

function objectCase(
  name: string,
  canonical: unknown,
  validate: PayloadValidator,
  requiredPath: Path,
  bodyPath: Path,
): SchemaCase {
  return {
    name,
    canonical,
    validate,
    missing: () => deletePath(canonical, requiredPath),
    extra: () => setPath(canonical, [...bodyPath, "extra"], true),
    wrongType: () => setPath(canonical, requiredPath, 42),
  };
}

function arrayCase(
  name: string,
  canonical: unknown,
  validate: PayloadValidator,
  requiredPath: Path,
): SchemaCase {
  const variant = requiredPath[0]!;
  return {
    name,
    canonical,
    validate,
    missing: () => deletePath(canonical, requiredPath),
    extra: () => setPath(canonical, [variant, 0, "extra"], true),
    wrongType: () => setPath(canonical, [variant], {}),
  };
}

function manualCase(
  name: string,
  canonical: unknown,
  validate: PayloadValidator,
  missing: unknown,
  extra: unknown,
  wrongType: unknown,
): SchemaCase {
  return {
    name,
    canonical,
    validate,
    missing: () => clone(missing),
    extra: () => clone(extra),
    wrongType: () => clone(wrongType),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deletePath(value: unknown, path: Path): unknown {
  const copy = clone(value);
  const [parent, key] = resolveParent(copy, path);
  if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
  else delete (parent as Record<string, unknown>)[String(key)];
  return copy;
}

function setPath(value: unknown, path: Path, replacement: unknown): unknown {
  const copy = clone(value);
  const [parent, key] = resolveParent(copy, path);
  (parent as Record<string | number, unknown>)[key] = replacement;
  return copy;
}

function resolveParent(
  value: unknown,
  path: Path,
): [Record<string, unknown> | unknown[], string | number] {
  assert.ok(path.length > 0);
  let current = value as Record<string, unknown> | unknown[];
  for (const part of path.slice(0, -1)) {
    current = (current as Record<string | number, Record<string, unknown> | unknown[]>)[part];
    assert.ok(current && typeof current === "object");
  }
  return [current, path.at(-1)!];
}
