# pi-graft

`@zendev-lab/pi-graft` is a Pi extension package for graft-backed editing workflows. It provides direct tools for the high-frequency agent path while leaving Pi's built-in `read`, `write`, and `edit` tools available.

## Mental model

`@zendev-lab/pi-graft` does not edit the working tree directly and does not speak graftd's socket protocol. Its TypeScript `graft-client` bridge is a thin process wrapper over `graft --json <argv>`: the Rust `graft` CLI remains the only wire translator, resolving socket location, daemon startup, typed daemon ops, daemon-owned `cli_exec`, and local routing internally. Tools shape convenient parameters into CLI argv/stdin and parse the JSON envelope/result:

```text
graft_help / graft_init / graft_doctor                                      -> workflow/bootstrap/diagnostics
graft_scratch_open { base: "graft:empty" | "candidate:..." | ... }          -> scratch:a
graft_write/read/edit/delete { base: "graft:empty" | "candidate:..." | ... } -> scratch:b
graft_write/read/edit/delete { from: "scratch:b" }                         -> scratch:c/d/...
graft_scratch_diff/drop/pin/unpin                                           -> daemon scratch lifecycle
graft_candidate_from_scratch { scratch: "scratch:d" }                      -> candidate:...
graft_validate / graft_admit / graft_show / graft_evidence / graft_materialize -> evidence / patch inspection
graft_repo { action: "add" | "list" | "sync" | "lock" | "update" }          -> managed repo config/cache/lock workflow
```

The extension keeps only convenience metadata (`base`, `lastScratch`, `lastCandidate`, and `lastPatch`) so later tool calls can omit `from`/`scratch` in the same workspace. That state is not the protocol entrance: every scratch tool accepts explicit `base` or `from`, and every result includes the returned scratch id in `details.result.scratch` for the next call. Rename has no separate operation yet; express it as `graft_delete` for the old path followed by `graft_write` for the new path.

A scratch is daemon-instance-scoped. Use `graft_scratch_pin` when a scratch must survive cleanup pressure; release the lease with `graft_scratch_unpin`. If `graftd` restarts, pass a fresh `base` or a still-reachable `from` scratch id; unsupported or unknown scratch ids fail through graftd's wire errors. Graft v3 treats cwd as an attach/routing key, not as the workspace identity; cwd may be a Git worktree.

## Commands and roles

pi-graft registers no slash commands. Human users should run the ordinary `graft ...` CLI directly; agents should use the `graft_*` tools below.

pi-graft also registers the explicit extension role `role:extension-patcher` (`id: patcher`) with `pi-roles`. This replaces the removed `graft_patch` public tool: call it through the canonical `role({ action: "call", role: "role:extension-patcher", instruction: ... })` surface when a patcher child run is appropriate. The role allowlist contains only Graft scratch/candidate/validation/evidence/repository/materialization tools; it has no `ask`, `task`, `task_write`, `goal`, `assign`, `role`, `workflow`, or `graft_patch` surface. If a patch request is unclear, the patcher reports the blocker upward instead of asking interactively or changing files.

## Tools

### Scratch file tools

These tools do not override Pi built-ins. Each scratch tool accepts either `base` (first operation) or `from` (continue a returned scratch), matching CLI `graft scratch ... --base/--from`.

- `graft_read` — read a UTF-8 text file and return `LINE#HASH:` anchors; `details.result.scratch` is the source scratch id.
- `graft_write` — write complete UTF-8 text content and return a new scratch id.
- `graft_edit` — apply strict hashline edits and return a new scratch id.
- `graft_delete` — delete a file and return a new scratch id.

`graft_edit` intentionally rejects legacy `oldText`/`newText` exact replacement. Call `graft_read` first, then use anchors from its output. Supported edit operations are `replace`, `append`, and `prepend`.

### Graft lifecycle and inspection tools

- `graft_help` — show maintained workflow guidance (`agent-workflow`) or command help.
- `graft_init` — bootstrap or register a workspace through `graft --json init`.
- `graft_status` — inspect pi-graft convenience state and graftd status.
- `graft_ps` — show global daemon and registry status.
- `graft_doctor` — diagnose or repair registry state.
- `graft_scratch_open` — open a base ref as a daemon scratch and remember it as `lastScratch`.
- `graft_scratch_diff` — compare two daemon scratch ids and return changed paths.
- `graft_scratch_drop` — drop an unpinned daemon scratch.
- `graft_scratch_pin` / `graft_scratch_unpin` — manage explicit scratch leases.
- `graft_candidate_from_scratch` — create a candidate through `graft --json candidate from-scratch`; its `expected` tool parameter maps to `--expect` flags.
- `graft_validate` — validate a candidate or patch.
- `graft_admit` — admit a validated candidate as a patch.
- `graft_show` — show a candidate or patch summary.
- `graft_evidence` — list evidence for a candidate or patch.
- `graft_candidates` — list unadmitted candidates.
- `graft_search` — search admitted patches.
- `graft_materialize` — plan or materialize an admitted patch target; dry-run defaults to true.
- `graft_repo` — manage configured repositories with the current `repo add/list/sync/lock/update` flow through `graft --json repo ...`; the Rust CLI decides local vs daemon execution.
- `graft_cli_exec` — allowlisted argv-only path for low-frequency read-only or diagnostic commands; bootstrap and mutation commands use dedicated tools.

## Example

```text
graft_write { base: "graft:empty", path: "note.txt", content: "alpha\nbeta\n" }
# -> details.result.scratch = scratch:...

graft_read { from: "scratch:...", path: "note.txt" }
# copy a LINE#HASH anchor from the output

graft_edit { from: "scratch:...", path: "note.txt", edits: [{ op: "replace", pos: "2#..:beta", lines: ["gamma"] }] }
# -> details.result.scratch = scratch:...

graft_write { from: "scratch:...", path: "obsolete.txt", content: "temporary\n" }
# -> details.result.scratch = scratch:...

graft_delete { from: "scratch:...", path: "obsolete.txt" }
# -> details.result.scratch = scratch:...

graft_candidate_from_scratch { scratch: "scratch:...", expected: ["CargoTestsPass"], message: "ready" }
```

## Runtime assumptions

The extension shells `GRAFT_BIN` when set, otherwise `graft`, always passing `--cwd <cwd>`. Non-help paths use `graft --json ...`; help/explain paths keep plain text output. Large scratch payloads go over stdin with `--content-stdin` and `--edits-stdin` so argv stays small and literal `"-"` file content remains possible.

pi-graft never passes `--socket`, never resolves `$GRAFT_HOME/run/daemon.sock`, and never starts `graftd` itself. If the CLI needs a daemon, Rust `graft`/`crates/graft-client` owns socket discovery, stale-socket handling, auto-start, and the server↔client wire contract. Set `GRAFT_BIN` if `graft` is not on `PATH`; daemon binary discovery remains a graft CLI concern.

The current implementation is UTF-8-text first. Binary, image, and directory behavior follows the current graft scratch wire errors and should fail loudly rather than falling back to disk reads or writes.

## Risk review

Verdict: **ship as an early integrated slice, with known caveats**.

- P1 — future default tool replacement would change core Pi semantics. Current mitigation: scratch operations are explicit `graft_*` tools, while Pi built-ins remain available.
- P1 — scratch state is not durable across daemon restart, and full multi-workspace scratch isolation depends on graftd's global-daemon workspace-state support. Mitigation: scratch ids are returned from each tool and pi-graft's convenience state is optional; lost scratch ids fail through graftd wire errors instead of hidden recovery.
- P1 — current graft property/admission behavior can still require project-specific policy tuning. Mitigation: `graft_candidate_from_scratch`, `graft_validate`, and `graft_admit` are explicit separate steps; graft_read/graft_write/graft_edit/graft_delete never auto-create candidates or auto-admit.
- P2 — file kind support is text-first. Mitigation: no passthrough fallback is implemented, so unsupported file kinds fail loudly.
- P2 — integration depends on Pi's tool registration surface staying stable. Mitigation: `@zendev-lab/pi-graft` exports a narrow boundary type and the registration test asserts that it installs no slash commands and the expected tools.

## Validation

Focused static check:

```bash
pnpm --filter pi-graft run check
```

Default test (real graftd E2E skipped unless opted in):

```bash
node --experimental-strip-types --test test/pi-graft-extension.test.ts
```

Real graftd E2E:

```bash
PI_GRAFT_E2E=1 node --experimental-strip-types --test test/pi-graft-extension.test.ts
```
