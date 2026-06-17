# Spark daemon-only reference study

This note captures the nyakore daemon/CLI patterns that Spark CLI should reuse, and the gateway pieces we intentionally exclude for the current daemon-only direction.

## Scope decision

Spark should implement a **local daemon**, not a gateway:

- daemon: local lock + file queue + worker loop + detached session-run executor.
- not gateway: no HTTP server, no bearer token, no `/jobs/*` API, no systemd/launchd service install in this slice.
- not Pi RPC: do not wrap `pi --mode rpc`; Spark already owns `SparkHostRuntime`, `SparkAgentLoop`, providers, sessions, skills, and extension loading.

## nyakore daemon mechanics to reuse

### Entrypoint and lock

nyakore's worker-only entrypoint is [`src/app/daemon.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/app/daemon.ts): sanitize environment, create worker context, acquire a daemon lock, run the worker loop, release the lock on shutdown.

The lock is in [`src/app/runtime-lock.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/app/runtime-lock.ts):

- lock file path: `<dataRoot>/runtime/<kind>.lock`.
- payload: `{ pid, startedAt }`.
- create with exclusive open (`wx`).
- if an existing lock is stale or malformed, unlink and retry once.
- release only deletes the lock if it still belongs to the current PID.

Spark mapping:

```text
SPARK_HOME/runtime/daemon.lock
packages/spark-cli/src/host/daemon/lock.ts
```

Keep the same JSON payload shape plus a `cwd`/`workspaceHash` field if useful for status output.

### Worker context and loop

nyakore builds a shared worker context in [`src/app/runtime-worker.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/app/runtime-worker.ts): container, queue, scheduler, runtime config, and active queue task tracking. The loop does repeated sweeps and queue/scheduler ticks, then sleeps for 250 ms when idle.

The daemon loop order is:

1. expire waiters
2. run due wakes
3. run due schedules
4. purge processed mailbox entries
5. process queue batch
6. run scheduler burst
7. sleep if no work happened

Spark should start smaller:

1. sweep stale/expired daemon task claims if implemented
2. process queue batch
3. optional future wake/schedule tick
4. sleep if idle

Spark mapping:

```text
packages/spark-cli/src/host/daemon/runtime-worker.ts
createSparkDaemonWorkerContext({ sparkHome, cwd? })
runSparkDaemonWorkerLoop({ context, isStopped, label })
```

### File queue

nyakore's [`src/core/queue.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/core/queue.ts) is deliberately simple:

```text
<dataRoot>/inbox/*.json
<dataRoot>/processed/*.json
<dataRoot>/failed/*.json
```

Each queue file stores `{ enqueuedAt, task }`. `enqueue()` writes JSON into inbox, `listInbox()` sorts JSON filenames, and processed/failed are just renames.

Spark mapping:

```text
SPARK_HOME/daemon/inbox/*.json
SPARK_HOME/daemon/processed/*.json
SPARK_HOME/daemon/failed/*.json
packages/spark-cli/src/host/daemon/queue.ts
```

Initial Spark task schema should be only:

```ts
export type SparkDaemonTask = {
   type: "session.run";
   sessionId: string;
   prompt: string;
   reset?: boolean;
   actor?: string;
   note?: string;
   input?: string;
};
```

Do not add `task.intake` until Spark has a concrete detached project/task intake story for the native CLI.

### Active file/session de-duplication

nyakore's [`src/app/queue-worker.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/app/queue-worker.ts) tracks:

```ts
active.files: Set<string>
active.sessions: Set<string>
```

It refuses to launch two queue items for the same session concurrently. That is the most important daemon safety rule for Spark because Spark JSONL session files are append-oriented and branch-linked.

Spark mapping:

```text
packages/spark-cli/src/host/daemon/queue-worker.ts
createSparkDaemonActiveTasks(): { files: Set<string>; sessions: Set<string> }
```

Rules:

- never process the same queue file twice in one daemon process;
- never run two `session.run` tasks for the same `sessionId` concurrently;
- on task failure, mark failed and persist a diagnosable error message;
- on success, move to processed after session save completes.

### Signals

nyakore uses a small `createSignals()` helper from [`src/app/signals.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/app/signals.ts) to stop loops. Spark should do the same rather than passing raw process signal handling through every module.

Spark mapping:

```text
packages/spark-cli/src/host/daemon/signals.ts
createSparkDaemonSignals(): { stopped, stop(), dispose() }
```

## nyakore CLI design to reuse

The user asked that CLI design can also be referenced. nyakore's CLI is useful mostly for **command registration shape**, not for gateway features.

### Root command registration

[`src/cli.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/cli.ts) uses `cac`, registers command groups, normalizes argv, sanitizes env once, then runs the matched command:

```text
registerRuntimeCommands(cli)
registerCollaborationCommands(cli)
registerQueueCommands(cli)
registerGatewayCommands(cli)
```

Spark should not necessarily add `cac` now, but should adopt the same separation:

```text
packages/spark-cli/src/cli.ts              thin root
packages/spark-cli/src/cli/commands.ts     command router/registration
packages/spark-cli/src/cli/daemon.ts       daemon command handlers
packages/spark-cli/src/cli/shared.ts       args/output helpers
```

Current Spark CLI (`packages/spark-cli/src/cli.ts`) only parses `--help` and treats everything else as initial TUI message. That is now too small for daemon work. We should preserve default TUI behavior but add explicit subcommands.

### Compound command normalization

nyakore's [`src/cli/command-argv.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/cli/command-argv.ts) rewrites multi-word commands like `gateway service install` into one command token for `cac`.

Spark can use a smaller version:

```text
spark daemon run
spark daemon status
spark daemon enqueue
spark daemon queue
```

If Spark does not adopt `cac`, a hand-written parser can still normalize the first two or three words into `{ command: "daemon.run" }`.

### Shared output helpers

[`src/cli/shared.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/cli/shared.ts) centralizes:

- `--json` output;
- readable table/object rendering;
- arg normalization and aliases;
- context creation;
- `runAndPrint()`.

Spark should copy this idea, not the whole implementation:

```text
packages/spark-cli/src/cli/shared.ts
- printJson(value)
- formatCliOutput(value)
- shouldPrintJson(args)
- runAndPrint(task, args)
- readString/readBoolean/readNumber validators
```

Daemon CLI output should be stable enough for tests and scripts. Prefer JSON for machine-readable smoke evidence.

### Queue commands

nyakore's [`src/cli/queue.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/cli/queue.ts) registers queue commands and delegates logic to [`src/cli/queue-ops.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/cli/queue-ops.ts). That split is exactly right for Spark.

Spark mapping:

```text
packages/spark-cli/src/cli/daemon.ts       register/parse daemon commands
packages/spark-cli/src/cli/daemon-ops.ts   handleDaemonRun/Status/Enqueue/Queue
```

Recommended commands:

```text
spark daemon run [--spark-home <dir>] [--cwd <dir>]
spark daemon status [--json]
spark daemon enqueue --session <id> -p <prompt> [--json]
spark daemon queue [--state inbox|processed|failed|all] [--limit <n>] [--json]
```

### Runtime commands

nyakore's [`src/cli/runtime.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/cli/runtime.ts) contains the worker-only `daemon` command and many operator commands. Spark should avoid copying the broad runtime command surface. Keep the daemon group narrow and leave interactive/session commands under existing `/sessions` and TUI flows until there is evidence they need CLI equivalents.

## nyakore gateway pieces to exclude

These are useful references but should not be implemented in the current Spark daemon slice:

- [`src/app/gateway.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/app/gateway.ts): combines HTTP gateway, job runner, channels, and worker loop. Spark is explicitly not doing gateway now.
- [`src/gateway/server.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/gateway/server.ts): `GET /health`, `POST /jobs/exec`, `GET /jobs/:id`, `GET /jobs/:id/wait`; exclude HTTP routes and bearer-token auth.
- [`src/gateway/job-store.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/gateway/job-store.ts): job records for HTTP API. Spark daemon can use queue task files instead; no separate gateway job abstraction yet.
- [`src/gateway/service.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/gateway/service.ts): systemd/launchd service installation; exclude from this phase.
- [`src/cli/gateway.ts`](https://github.com/ShigureLab/nyakore/blob/main/src/cli/gateway.ts): client commands for remote gateway health/exec/job/wait/service; exclude, except as a warning about command sprawl.

## Spark implementation sketch

### Proposed files

```text
packages/spark-cli/src/host/daemon/
├── lock.ts
├── queue.ts
├── queue-worker.ts
├── runtime-worker.ts
├── session-executor.ts
├── signals.ts
└── types.ts

packages/spark-cli/src/cli/
├── args.ts
├── commands.ts
├── daemon.ts
├── daemon-ops.ts
└── shared.ts
```

### Daemon worker context

```ts
export interface SparkDaemonWorkerContext {
   sparkHome: string;
   cwd: string;
   queue: SparkDaemonQueue;
   active: SparkDaemonActiveTasks;
   createServices: () => Promise<SparkCliHostServices>;
}
```

Use `createSparkCliHostServices()` from `packages/spark-cli/src/host/bootstrap.ts` for host runtime construction. Do not duplicate provider/extension/session/skill initialization in daemon code.

### Worker loop tick order

```text
runSparkDaemonWorkerLoop
  acquire daemon lock
  while not stopped:
    didQueueWork = processSparkDaemonQueueBatch()
    if no work: sleep(250ms)
  release daemon lock
```

Future hooks can insert schedule/wake sweeps before queue processing, but the first version should stay queue-only.

### Queue execution

```text
read queued session.run
  if active.sessions has sessionId: skip this tick
  mark active file/session
  load/create Spark host services
  load target JSONL session or fail unknown session
  submit prompt through SparkAgentLoop or SparkAgentSession facade
  persist new entries
  rename inbox -> processed
on error:
  write failed metadata or keep original payload plus error
  rename inbox -> failed
```

A future `SparkAgentSession` facade should sit between daemon and raw `SparkAgentLoop`, because daemon, TUI, and future print mode all need the same submit/save/compact/branch behavior.

## Tests to add next

- `test/spark-daemon-lock.test.ts`: lock acquire/release, duplicate lock fails, stale lock recovery.
- `test/spark-daemon-queue.test.ts`: enqueue/list/read/processed/failed paths under temp `SPARK_HOME`.
- `test/spark-daemon-worker.test.ts`: queue batch launches at most one task per session and moves failures to failed.
- `test/spark-cli-daemon.test.ts`: parser and handler coverage for `spark daemon run/status/enqueue/queue`.
- later integration: fake provider queued `session.run` produces a saved JSONL assistant message.

## Open implementation choices

No user decision is needed for the next task, but these should be kept visible:

- Use `SPARK_HOME/daemon/*` instead of `.spark/daemon/*` by default so one daemon can work across workspaces if passed explicit cwd/session. Tests can override `sparkHome`.
- Keep queue files append-only/rename-based; do not introduce SQLite or HTTP job IDs until a concrete remote-control requirement appears.
- Keep daemon command names under `spark daemon ...`; avoid `gateway` naming entirely.
