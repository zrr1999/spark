# spark-graft

`@zendev-lab/spark-graft` is a Spark extension package for graft-backed editing workflows. It provides direct tools for the high-frequency agent path while leaving Pi's built-in `read`, `write`, and `edit` tools available.

## Mental model

`@zendev-lab/spark-graft` does not edit the working tree directly and does not speak graftd's socket protocol. Its TypeScript `graft-client` bridge is a thin process wrapper over `graft --json <argv>`: the Rust `graft` CLI remains the only wire translator, resolving socket location, daemon startup, typed daemon ops, daemon-owned `cli_exec`, and local routing internally. Tools shape convenient parameters into CLI argv/stdin and parse the JSON envelope/result:

```text
graft_help / graft_init / graft_doctor                                      -> workflow/bootstrap/diagnostics
graft_scratch_open { base?: "graft:empty" | "candidate:..." | ... }         -> scratch:a
graft_write/read/edit/delete { base?: "graft:empty" | "candidate:..." | ... } -> scratch:b
graft_write/read/edit/delete { from: "scratch:b" }                         -> scratch:c/d/...
graft_scratch_diff/drop/pin/unpin                                           -> daemon scratch lifecycle
graft_candidate_from_scratch { scratch: "scratch:d" }                      -> candidate:...
graft_validate / graft_admit / graft_show / graft_evidence / graft_materialize -> evidence / patch inspection
graft_repo { action: "add" | "list" | "sync" | "lock" | "update" }          -> managed repo config/cache/lock workflow
```

The extension keeps only convenience metadata (`base`, `lastScratch`, `lastCandidate`, and `lastPatch`) so later tool calls can omit `from`/`scratch` in the same workspace. That state is not the protocol entrance: every scratch tool accepts explicit `base` or `from`, and every result includes the returned scratch id in `details.result.scratch` for the next call. Pass `base` only for the first operation from a materialized ref; pass `from` only when continuing an existing scratch. Never pass both in one scratch tool call. When a workflow agent sets `GRAFT_BASE_REF`, the first `graft_scratch_open`/`graft_read`/`graft_write`/`graft_edit`/`graft_delete` call may omit `base`; the CLI resolves the env ref exactly like `--base`, while explicit `base` wins and explicit `from` ignores the env ref. Rename has no separate operation yet; express it as `graft_delete` for the old path followed by `graft_write` for the new path.

A scratch is daemon-instance-scoped. Use `graft_scratch_pin` when a scratch must survive cleanup pressure; release the lease with `graft_scratch_unpin`. If `graftd` restarts, pass a fresh `base` or a still-reachable `from` scratch id; unsupported or unknown scratch ids fail through graftd's wire errors. Graft v3 treats cwd as an attach/routing key, not as the workspace identity; cwd may be a Git worktree.

## Commands and roles

spark-graft registers no slash commands. Human users should run the ordinary `graft ...` CLI directly; agents should use the `graft_*` tools below.

spark-graft also registers the explicit extension role `role:extension-patcher` (`id: patcher`) with `spark-roles`. This replaces the removed `graft_patch` public tool: call it through the canonical `role({ action: "call", role: "role:extension-patcher", instruction: ... })` surface when a patcher child run is appropriate. The role allowlist contains only Graft scratch/candidate/validation/evidence/repository/materialization tools; it has no `ask`, `task`, `task_write`, `goal`, `assign`, `role`, `workflow`, or `graft_patch` surface. If a patch request is unclear, the patcher reports the blocker upward instead of asking interactively or changing files.

## Tools

### Normal mode vs sandbox replacement mode

The default spark-graft entrypoint (`@zendev-lab/spark-graft/extension`) is ordinary explicit graft tooling: it registers `graft_*` tools and does **not** override Pi's built-in `read`, `write`, `edit`, `grep`, `find`, or `ls` tools.

The opt-in sandbox entrypoint (`@zendev-lab/spark-graft/sandbox`, or this repo's `packages/spark-graft/src/sandbox-entry.ts` during local development) is the file-tool replacement profile. Load it only when you want file operations to enter the Graft lifecycle. It registers sandbox lifecycle helpers plus tools named exactly `read`, `write`, `edit`, `grep`, `find`, and `ls`; with `--no-builtin-tools`, those names still work because they come from the sandbox extension rather than Pi built-ins.

Typical non-interactive local-development invocation:

```bash
GRAFT_BIN=/path/to/graft \
pi -p --no-extensions --no-builtin-tools \
  -e ./packages/spark-graft/src/sandbox-entry.ts \
  --tools graft_sandbox_enter,read,write,edit,grep,find,ls,graft_sandbox_checkpoint,graft_sandbox_materialize \
  "enter sandbox, edit files, checkpoint, and materialize"
```

Sandbox workflow:

```text
graft_sandbox_enter { repo: ".", workspace: "/tmp/my-graft-ws", base: "HEAD" }
read/edit/write/grep/find/ls                         # all operate on sandbox scratch state
graft_sandbox_checkpoint { admit: true, message: "ready" }
graft_sandbox_materialize {}                         # dry-run by default; no directory is created
graft_sandbox_materialize { dryRun: false }          # creates isolated .worktrees/... inspection output
graft_sandbox_promote { to: "branch", apply: true } # explicit --yes side-effect boundary
```

Safety boundaries:

- sandbox `read`/`write`/`edit` never write the Git working tree; they read/write Graft scratch state and update sandbox `lastScratch`;
- `graft_sandbox_checkpoint` creates candidate/patch state only when called;
- `graft_sandbox_materialize` defaults to dry-run and says no directory was created;
- `graft_sandbox_promote` defaults to dry-run and requires `apply:true` to add Graft's `--yes` gate;
- sandbox `find`/`ls` prefer Graft's native `tree list` API when available and fall back to temporary Graft materialized-run state plus tracked scratch changes; sandbox `grep` uses native `tree grep` for literal, case-sensitive searches and otherwise uses the materialized fallback to preserve Pi grep semantics; set `PI_GRAFT_SANDBOX_TREE_BACKEND=materialized|native|auto` to force or inspect backend behavior; none of these paths traverse the Git working tree directly;
- the sandbox `tool_call` guardrail blocks obvious shell/cue/script file-I/O bypasses such as `cat`, `sed`, redirection writes, `rm`, `cp`, and direct script file APIs, while allowing validation commands that do not directly access files;
- `graft_sandbox_exit` clears sandbox state only; the file-tool names `read`/`write`/`edit`/`grep`/`find`/`ls` remain sandbox overrides until Pi reloads without the sandbox entrypoint.

Exit/reload behavior is profile-level, not per-tool-call. After `graft_sandbox_exit`, use `graft_sandbox_status` to confirm state is inactive. To use ordinary Pi built-in file tools again, start or reload Pi without `@zendev-lab/spark-graft/sandbox`; if the previous run used `--no-builtin-tools`, omit that flag too, because there are no built-ins to restore inside that profile.

### Scratch file tools

These tools do not override Pi built-ins. Each scratch tool accepts either `base` (first operation) or `from` (continue a returned scratch), matching CLI `graft scratch ... --base/--from`. If neither is provided and there is no remembered `lastScratch`, `GRAFT_BASE_REF` is used as the implicit first-operation base; if it is absent or blank, the tool fails loudly. Treat selectors as mutually exclusive: do not include `base` once you have a `scratch:*` id to pass as `from`.

- `graft_read` — read a UTF-8 text file and return `LINE#HASH:` anchors; `details.result.scratch` is the source scratch id.
- `graft_write` — write complete UTF-8 text content and return a new scratch id.
- `graft_edit` — apply strict hashline edits and return a new scratch id.
- `graft_delete` — delete a file and return a new scratch id.

`graft_edit` intentionally rejects legacy `oldText`/`newText` exact replacement. Call `graft_read` first, then use anchors from its output. Supported edit operations are `replace`, `append`, and `prepend`.

### Graft lifecycle and inspection tools

- `graft_help` — show maintained workflow guidance (`agent-workflow`) or command help.
- `graft_init` — bootstrap or register a workspace through `graft --json workspace init`.
- `graft_status` — inspect spark-graft convenience state and graftd status.
- `graft_ps` — show global daemon and registry status.
- `graft_doctor` — diagnose or repair registry state.
- `graft_scratch_open` — open a base ref (explicit `base`, or `GRAFT_BASE_REF` when omitted) as a daemon scratch and remember it as `lastScratch`.
- `graft_scratch_diff` — compare two daemon scratch ids and return changed paths.
- `graft_scratch_drop` — drop an unpinned daemon scratch.
- `graft_scratch_pin` / `graft_scratch_unpin` — manage explicit scratch leases.
- `graft_candidate_from_scratch` — create a candidate through `graft --json candidate from-scratch`; its `expected` tool parameter maps to `--expect` flags.
- `graft_validate` — validate a candidate or patch through `graft patch validate`.
- `graft_admit` — admit a validated candidate as a patch through `graft patch admit`.
- `graft_show` — show a candidate or patch summary through `graft patch show`.
- `graft_evidence` — list evidence for a candidate or patch.
- `graft_candidates` — list unadmitted candidates, optionally filtered by constraint.
- `graft_search` — search admitted patches through `graft patch search`, optionally filtered by constraint.
- `graft_materialize` — plan or materialize an admitted patch target through `graft patch materialize`; dry-run defaults to true.
- `graft_repo` — manage configured repositories with the current `repo add/list/sync/lock/update` flow through `graft --json repo ...`; the Rust CLI decides local vs daemon execution.
- `graft_cli_exec` — allowlisted argv-only path for low-frequency advanced CLI workflows (`explain`, `sync`, `get`, `run`, `bundle export/import`, `repo ...`, `workspace ...`, and selected `patch ...` inspection/promotion commands); high-frequency scratch and patch lifecycle commands use dedicated typed tools.

When several Graft lifecycle or inspection calls share one workspace/daemon state, issue them sequentially instead of in parallel. In validation, parallel `graft_show`/`graft_evidence` calls could contend on the local writer lock; the same calls succeeded when sequenced.

## Example

```text
# With GRAFT_BASE_REF set by the workflow/role-run environment, `base` may be omitted for the first operation.
graft_write { path: "note.txt", content: "alpha\nbeta\n" }
# -> details.result.scratch = scratch:...

graft_read { from: "scratch:...", path: "note.txt" }
# copy a LINE#HASH anchor from the output

graft_edit { from: "scratch:...", path: "note.txt", edits: [{ op: "replace", pos: "2#..:beta", lines: ["gamma"] }] }
# -> details.result.scratch = scratch:...

graft_write { from: "scratch:...", path: "obsolete.txt", content: "temporary\n" }
# -> details.result.scratch = scratch:...

graft_delete { from: "scratch:...", path: "obsolete.txt" }
# -> details.result.scratch = scratch:...

graft_candidate_from_scratch { scratch: "scratch:...", expected: ["tests_pass"], message: "ready" }
```

## Runtime constraints

The extension invokes `${GRAFT_BIN:-graft} --cwd <cwd>`, uses JSON mode for non-help commands, and sends large scratch content/edits over stdin. `GRAFT_BASE_REF` is only an implicit first-operation base when neither `base` nor `from` is supplied.

Rust `graft` owns socket discovery, daemon startup, and wire translation; this extension never passes a socket or starts `graftd`. Scratch operations are UTF-8 text only. Binary, image, directory, or unknown scratch operations fail explicitly and never fall back to direct disk access. Scratch state is daemon-instance scoped unless pinned.
