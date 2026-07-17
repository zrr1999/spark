# Public tools and commands

This file names stable agent-facing capabilities. Schemas and result types live with their owner packages.

## Foreground commands

- `/plan` researches and creates/refines verifiable tasks without executing them.
- `/implement` claims and completes ready work.
- `/loop` runs recurring ticks and must schedule each next tick; it has no completion gate.
- `/goal` uses reviewer-backed decisions and reviewer-gated completion.
- `/workflow` executes a selected saved workflow; `/ultracode` explicitly opts into approval-gated fan-out.

Session operating phases are only `plan` and `implement`. `plan` covers investigation, explanation, review, and durable planning without requiring durable writes for ordinary answers. Research remains a task kind and workflow capability, not a separate session phase. Repro setup uses one `plan` phase with both problem-definition and reproduction-strategy acceptance conditions.

## State and execution

- `task_read` inspects task, project, workspace, project-list, and run state.
- `task_write` selects projects and plans, claims, finishes, recovers, or updates tasks. New and claimed tasks require an objectively verifiable plan.
- `assign` dispatches the ready frontier and dry-runs by default.
- `goal`, `loop`, `drive`, `phase`, and `repro` own their named foreground state machines.
- `workflow` lists/reads controlled selectors; `workflow_run` executes a saved selector or trusted metadata-first script.

Direct role/session calls do not create task attribution.

## Evidence and context

- `ask` is the only structured question surface; cancellation is not approval.
- `artifact` stores provenance-backed `document | record | trace | knowledge` evidence and lifecycle curation.
- `learning`, `recall`, and `memory` remain distinct: evidence-backed rules, explicit candidates, and explicit durable memory.
- `context` lists/previews registered bounded providers and accepts no arbitrary provider prompt.

## Roles and sessions

- `role` manages reusable definitions/model settings and fresh anonymous calls. It does not accept session lifecycle, mail, `resource=session`, or `sessionId`.
- `session` manages persistent lifecycle, bindings, calls, classification, and mail. List/get expose surface, activity, lifecycle, adapters, and external keys.
- `send kind=request` asynchronously submits the exact body to an unarchived local session; `send kind=question` requires an idle local target and waits for a bounded terminal result without cancelling execution on wait timeout; `send kind=notification` persists without triggering and may deliver through channel bindings.

Both call paths share one headless host and `SparkAgentSession`. Full policy is in [`sessions-and-channels.md`](./sessions-and-channels.md).

## Shell and files

`spark-cue` tools (`cue_exec`, `cue_run`, `cue_script`, `script_run`, `script_eval`, `cue_jobs`, `cue_resources`, `cue_schedule`, `cue_scope`, `cue_history`) provide direct-exec jobs and scripts. `cue_resources` — inspect resource providers and snapshots.

`script_run`/`script_eval` support cue-shell and Python. Python uses `uv run --script <path>` or `uv run --script -`; `venv` is python-only, and `scope` is not a `script_run`/`script_eval` parameter. Cue-shell scripts use `RunScript { path, input }` in a fresh isolated scope.

`spark-files` provides bounded `read`, `write`, `edit`, `ls`, `grep`, and `find`. `read` has one UTF-8 text protocol: it always renders the raw-content SHA-256 version and stable `LINE#HASH:text` anchors for the returned window, with matching structured metadata; the byte limit applies to this final rendered output, including anchors. Read pagination accepts positive integers only; LF, CRLF, CR-only, mixed separators, and a UTF-8 BOM are reported as metadata, while invalid UTF-8 fails explicitly. `write` has no blind compatibility path: `expectedVersion` is required and must be the version returned by `read`, or `missing` for create-only intent. It uses a same-directory temporary file plus fsync/rename and rejects stale rewrites. Spark serializes writes by canonical target path inside one process (including symlinked parent aliases), rejects direct symbolic-link targets, and therefore gives same-version in-process Spark writers one winner. `edit` commits through the same atomic content-version check. Cross-process and non-cooperating external writers remain an optimistic-concurrency race; atomic replacement also detaches the replaced name from any sibling hard links rather than mutating their shared inode.

These are working-tree mechanisms, not Graft state. Scratch graphs, candidates, daemon lifecycle, and promotion remain in `@zendev-lab/spark-graft`, which is retained for explicit opt-in use but is not loaded by Spark's default extension profile or base prompt.

## Tool execution policy

Tool owners declare one canonical `policy` with `effect`, sibling-call `executionMode`, domains, phases, and approval. The host resolves and freezes that policy at registration. Legacy top-level effect/execution/approval fields remain compatibility inputs, but conflicts or malformed declarations fail closed to unknown effect, sequential execution, and required approval.

Registered tools and active tools are distinct. Only active tools enter the model schema or prompt manifest. A batch executes concurrently only when every call resolves to an active, approval-free `read` tool with `executionMode=parallel`; mixed, unknown, write-capable, or policy-changing batches stay sequential. Parallel results are committed to the transcript in the model's original call order, with a default concurrency limit of four.

## Web and host policy

`web_search`, `fetch_content`, `get_search_content`, and `code_search` treat fetched text as untrusted data. Credentials are configuration and must not appear in output.

Use one canonical action tool per stateful domain. Hosts may narrow surfaces; channel-bound hosts expose only `session` and permanently disable cue tools, `role`, `assign`, and `workflow_run`.
