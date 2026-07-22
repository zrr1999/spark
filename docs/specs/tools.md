# Public tools and commands

This file names stable agent-facing capabilities. Schemas and result types live with their owner packages.

## Foreground commands

- `/plan` researches and creates/refines verifiable tasks without executing them.
- `/implement` claims and completes ready work.
- `/loop` runs recurring ticks and must schedule each next tick; it has no completion gate.
- `/goal` uses reviewer-backed decisions and reviewer-gated completion.
- `/workflow` executes a selected saved workflow; `/ultracode` explicitly opts into approval-gated fan-out.

Session operating phases are only `plan` and `implement`. `plan` covers investigation, explanation, review, and durable planning without requiring durable writes for ordinary answers. Research remains a task kind and workflow capability, not a separate session phase. Repro setup uses one research-first `plan` phase with typed, artifact-backed requirements: freeze the reproduction contract, verify whether a runnable competitor/reference baseline already exists (typically Megatron), ask the user how to construct or obtain it when missing, inspect reusable implementation and extension boundaries, compare real-module and eager alignment paths, record the implementation and alignment decisions through user-answered canonical asks, and pass a minimum baseline probe against an available or user-approved constructed baseline. Readiness and gates are derived from that evidence; no caller can force-pass them with a bare boolean. Goal and repro prefer the main session for scheduling and execution, and must call `ask` when blocked by a missing user decision or another problem the user can unblock rather than guessing or defaulting to role/session/workflow fan-out. Goal mode also adopts the conservative research-first policy: inspect discoverable facts and run focused probes before sending a still-material decision to reviewer auto-answer.

## State and execution

- `task_read` inspects task, project, workspace, project-list, and run state.
- `task_write` selects projects and plans, claims, finishes, recovers, or updates tasks. New and claimed tasks require an objectively verifiable plan.
- `assign` dispatches the ready frontier and dry-runs by default.
- `goal`, `loop`, `drive`, `phase`, and `repro` own their named foreground state machines. Spark native hosts expose the plan/implement switch as `phase({ action })` (`spark-modes` remains the host-neutral lens mechanism that defaults its descriptor name to `mode`).
- `workflow` lists/reads controlled selectors; `workflow_run` executes a saved selector or trusted metadata-first script.

Direct role/session calls do not create task attribution.

## Evidence and context

- `ask` is the only structured question surface; cancellation is not approval.
- `evidence` is an **agent-internal ledger** (not Cockpit/user UI): compact provenance-backed `record | trace | knowledge | document` notes. Prefer `format=json` bodies `{ summary, data? }`. Tool-result side channels publish `evidence.update` (not `artifact.update`).
- `artifact` owns product-facing deliverables only: `issue | pr | preview` (forge-backed ISSUE/PR; continuous md/mdx/html preview). PR work prefers an attached git worktree under `.spark/worktrees/`. Product tool results publish `artifact.update`.
- `memory` is the only public memory tool: `memory({ action, kind? })` with `kind: "entry" | "learning" | "candidate"` (default `entry`). Durable entries, evidence learnings, and recall candidates share this surface. Pi-memory aliases (`memory_write`/`memory_read`/`scratchpad`/`memory_search`/`memory_status`) are opt-in (`enablePiCompatAliases`; Pi product entry on, Spark native off). Reflection pipelines also live in `@zendev-lab/spark-memory` (under `.spark/memory/reflections/`).
- `context` lists/previews registered bounded providers and accepts no arbitrary provider prompt.

## Roles and sessions

- `role` manages reusable definitions/model settings and fresh anonymous calls. It does not accept session lifecycle, mail, `resource=session`, or `sessionId`.
- `session` manages persistent lifecycle, bindings, calls, classification, and mail. List/get expose surface, activity, lifecycle, adapters, and external keys.
- `send kind=request` asynchronously submits the exact body to an unarchived local session. Default `wait=accepted` returns after acceptance; when the target reaches a terminal status the daemon submits one completion-summary turn on the sender so it can synthesize immediately. `wait=completed` polls for a bounded terminal result without a second wake and without cancelling execution on wait timeout.

Both call paths share one headless host and `SparkAgentSession`. Full policy is in [`sessions-and-channels.md`](./sessions-and-channels.md).

## Shell and files

`spark-cue` tools (`cue_exec`, `cue_run`, `cue_script`, `script_run`, `script_eval`, `cue_jobs`, `cue_resources`, `cue_schedule`, `cue_scope`, `cue_history`) provide direct-exec jobs and scripts. `cue_resources` — inspect resource providers and snapshots.

`script_run`/`script_eval` support cue-shell and Python. Python uses `uv run --script <path>` or `uv run --script -`; `venv` is python-only, and `scope` is not a `script_run`/`script_eval` parameter. Cue-shell scripts use `RunScript { path, input }` in a fresh isolated scope.

`spark-files` provides bounded `read`, `write`, `edit`, `ls`, `grep`, and `find`. `read` has one UTF-8 text protocol: it always renders the raw-content SHA-256 version and stable `LINE#HASH:text` anchors for the returned window, with matching structured metadata; the byte limit applies to this final rendered output, including anchors. Read pagination accepts positive integers only; LF, CRLF, CR-only, mixed separators, and a UTF-8 BOM are reported as metadata, while invalid UTF-8 fails explicitly. `write` has no blind compatibility path: `expectedVersion` is required and must be the version returned by `read`, or `missing` for create-only intent. It uses a same-directory temporary file plus fsync/rename and rejects stale rewrites. Spark serializes writes by canonical target path inside one process (including symlinked parent aliases), rejects direct symbolic-link targets, and therefore gives same-version in-process Spark writers one winner. `edit` commits through the same atomic content-version check. Cross-process and non-cooperating external writers remain an optimistic-concurrency race; atomic replacement also detaches the replaced name from any sibling hard links rather than mutating their shared inode.

These are working-tree mechanisms, not Graft state. Scratch graphs, candidates, daemon lifecycle, and promotion remain in `@zendev-lab/spark-graft` via the canonical `graft({ action })` surface (opt-in; not loaded by Spark's default extension profile or base prompt).

## Tool execution policy

Tool owners declare one canonical `policy` with `effect`, sibling-call `executionMode`, domains, phases, and approval. The host resolves and freezes that policy at registration. Legacy top-level effect/execution/approval fields remain compatibility inputs, but conflicts or malformed declarations fail closed to unknown effect, sequential execution, and required approval.

Registered tools and active tools are distinct. Only active tools enter the model schema or prompt manifest. A batch executes concurrently only when every call resolves to an active, approval-free `read` tool with `executionMode=parallel`; mixed, unknown, write-capable, or policy-changing batches stay sequential. Parallel results are committed to the transcript in the model's original call order, with a default concurrency limit of four.

## Web and host policy

`web_search`, `fetch_content`, `get_search_content`, and `code_search` treat fetched text as untrusted data. Credentials are configuration and must not appear in output.

Use one canonical action tool per stateful domain. Hosts may narrow surfaces; channel-bound hosts expose only `session` and permanently disable cue tools, `role`, `assign`, and `workflow_run`.
