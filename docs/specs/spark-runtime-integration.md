# Spark runtime integration guide

Status: current external contract for `spark run --json` and scheduler-style CLI integration.

Spark can be used as a terminal agent or as a local runtime launched by another manager such as Multica, an internal scheduler, or a CI wrapper. The stable integration surface is the root `spark` CLI dispatcher plus the daemon queue/IPC boundary.

## Command surface

```text
spark run "fix the failing tests"                 # foreground, human-readable acceptance output
spark run --json "fix the failing tests"          # JSONL event stream
spark run --resume <session-id> "continue"        # submit to an existing session id
spark bg "fix the failing tests"                  # enqueue in the Spark daemon and return
spark bg --session <session-id> "continue"        # enqueue onto an explicit daemon session
spark doctor                                      # daemon/auth/workspace/cockpit health JSON
```

Compatibility aliases remain supported:

```text
spark --print <prompt>
spark -p <prompt>
spark --mode json --print <prompt>
spark daemon submit --session <id> --prompt <text> [--json]
```

`run` is a thin first-class replacement for the legacy `--print` path. `run --json` maps to the same event stream as `--mode json --print`. `bg` maps to daemon `submit`; when the caller does not supply a session id, Spark creates a `spark-bg-*` session id before submitting.

## `spark run --json` JSONL stream

The stream is newline-delimited JSON: one UTF-8 JSON object per line, no outer array. Consumers should dispatch on the `type` field, ignore unknown fields, and tolerate additional event types in future versions.

Current event order:

1. `session`
2. `agent_start`
3. `turn_start`
4. `queue_update`
5. `turn_end`
6. `agent_end`

### Event schemas

#### `session`

```json
{"type":"session","version":3,"id":"spark-print-labc123","timestamp":"2026-07-03T00:00:00.000Z","cwd":"/repo"}
```

Fields:

- `type`: literal `session`.
- `version`: session/event shape version. Current value: `3`.
- `id`: Spark session id used for the headless turn.
- `timestamp`: ISO timestamp when the JSONL stream is produced.
- `cwd`: current working directory for the CLI process.

#### `agent_start`

```json
{"type":"agent_start"}
```

Marks the beginning of the accepted headless agent invocation.

#### `turn_start`

```json
{"type":"turn_start"}
```

Marks the beginning of the submitted turn.

#### `queue_update`

```json
{"type":"queue_update","steering":[],"followUp":["fix the failing tests"]}
```

Fields:

- `steering`: currently an array of steering updates; `run --json` emits an empty array for the initial accepted prompt.
- `followUp`: array containing the submitted prompt text.

#### `turn_end`

```json
{
  "type": "turn_end",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "Spark daemon accepted the headless prompt." }]
  },
  "toolResults": [],
  "result": {
    "action": "submit",
    "result": {
      "fileName": "queued.json",
      "filePath": "/state/spark/daemon/inbox/queued.json",
      "task": { "type": "session.run", "sessionId": "spark-print-labc123", "prompt": "fix the failing tests" },
      "observedAt": "2026-07-03T00:00:00.000Z"
    }
  }
}
```

Fields:

- `message`: assistant-style acceptance message. Current `run --json` confirms daemon acceptance rather than streaming the full future transcript.
- `toolResults`: currently an empty array for this CLI path.
- `result`: daemon submit result. Consumers should use `result.result.fileName`, `result.result.filePath`, `result.result.task.sessionId`, and `result.result.observedAt` to correlate the queued daemon turn.

#### `agent_end`

```json
{"type":"agent_end","messages":[]}
```

Marks the end of the JSONL acceptance stream. Current `messages` is empty for this CLI path.

## Example parser

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("spark", ["run", "--json", "fix the failing tests"], {
  stdio: ["ignore", "pipe", "inherit"],
});

const events: Array<Record<string, unknown>> = [];
for await (const line of createInterface({ input: child.stdout })) {
  if (!line.trim()) continue;
  const event = JSON.parse(line) as { type?: string } & Record<string, unknown>;
  events.push(event);
  if (event.type === "turn_end") {
    const submit = (event.result as { result?: unknown } | undefined)?.result;
    // Persist submit.fileName/filePath/sessionId for later daemon/session lookup.
    console.log("accepted", submit);
  }
}

const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
if (exitCode !== 0) throw new Error(`spark run failed: ${exitCode}`);
```

## Scheduler/runtime integration pattern

### Foreground one-shot work

Use `spark run --json <prompt>` when a manager wants immediate acknowledgement and a parseable event stream. Treat `turn_end.result` as the durable submit acknowledgement. Store:

- session id: `turn_end.result.result.task.sessionId`
- daemon queue file: `turn_end.result.result.fileName`
- observed timestamp: `turn_end.result.result.observedAt`
- prompt/source metadata in the manager's own job record

A scheduler should display the accepted state immediately, then inspect daemon/session/task artifacts through Spark daemon/Cockpit APIs or project evidence surfaces as they become available.

### Resume or correlate sessions

Use `spark run --resume <session-id> <prompt>` when the manager already owns a Spark session id. This maps to the same daemon session id used by legacy `--session`/`--session-id` options.

### Background queue submit

Use `spark bg <prompt>` when a manager wants fire-and-return behavior. Spark generates a `spark-bg-*` session id unless `--session` or `--resume` is supplied. For strict correlation, schedulers should pass their own session id:

```text
spark bg --session multica-job-123 "continue implementation"
```

For lower-level daemon control, use:

```text
spark daemon submit --session multica-job-123 --prompt "continue implementation" --json
spark daemon queue --state all --json
spark daemon sessions export --session multica-job-123 --format jsonl
spark daemon sessions replay --session multica-job-123
```

### Health checks

Run `spark doctor` before assigning work to a host. The JSON contains `checks.daemon`, `checks.credentials`, `checks.workspace`, and `checks.cockpit`, plus paths/config details for diagnostics.

### Evidence and artifacts

Spark's product value comes from task/evidence provenance, not just process exit codes. A scheduler integrating Spark should:

1. keep the CLI JSONL acceptance record;
2. store daemon queue/session ids for correlation;
3. link later Spark task artifacts/review records when the run is project-bound;
4. present evidence refs and review verdicts in its own UI rather than flattening them into logs.

## Compatibility rules

- JSONL event `type` names are stable for the current CLI stream; new event types may be inserted in future versions.
- Consumers must ignore unknown fields and preserve known submit identifiers.
- Non-zero exit codes indicate CLI/dispatch/daemon submit failure before an accepted `turn_end` result.
- The legacy `--print` and `--mode json --print` aliases remain supported, but new integrations should use `spark run` and `spark run --json`.
- Do not parse human-readable `spark run` output for automation; use `--json`.
