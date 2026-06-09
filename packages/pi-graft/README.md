# pi-graft

`pi-graft` is a Pi extension package for graft-backed editing workflows. It provides direct tools for the high-frequency agent path while leaving Pi's built-in `read`, `write`, and `edit` tools available.

## Mental model

`pi-graft` does not edit the working tree directly. It talks to the machine-local global `graftd` at `$GRAFT_HOME/run/daemon.sock` and uses the same canonical daemon protocol as the CLI:

```text
graft_help / graft_init / graft_doctor                                    -> workflow/bootstrap/diagnostics
graft_write/read/edit/delete { base: "graft:empty" | "candidate:..." | ... } -> scratch:a
graft_write/read/edit/delete { from: "scratch:a" }                         -> scratch:b/c/...
graft_candidate_from_scratch { scratch: "scratch:c" }                      -> candidate:...
graft_validate / graft_admit / graft_show / graft_evidence / graft_materialize -> evidence / patch inspection
graft_repo { action: "add" | "list" | "sync" | "lock" | "update" }          -> managed repo config/cache/lock workflow
```

The extension keeps only convenience metadata (`base`, `lastScratch`, `lastCandidate`, and `lastPatch`) so later tool calls can omit `from`/`scratch` in the same workspace. That state is not the protocol entrance: every scratch tool accepts explicit `base` or `from`, and every result includes the returned scratch id in `details.result.scratch` for the next call. Rename has no separate operation yet; express it as `graft_delete` for the old path followed by `graft_write` for the new path.

A scratch is daemon-instance-scoped. If `graftd` restarts, pass a fresh `base` or a still-reachable `from` scratch id; unsupported or unknown scratch ids fail through graftd's wire errors. Graft v3 treats cwd as an attach/routing key, not as the workspace identity; cwd may be a Git worktree.

## Commands

- `/graft-attach [workspace-id|--status]` — attach cwd to a Graft workspace route, or show attach status. Without an argument, Graft defaults to `ws:default`.
- `/graft-detach` — remove the cwd registry route without deleting workspace repo metadata.
- `/graft-ps` — show `$GRAFT_HOME`, global daemon socket/pid, registered workspaces, routes, and repo paths.
- `/graft-doctor [--rebuild-registry]` — diagnose registry/workspace/repo-path reachability, optionally rebuilding missing machine-local workspace records from `$GRAFT_HOME/workspaces/*`.
- `/graft-close` — clear pi-graft's convenience state in the Pi session. Returned scratch ids can still be passed explicitly as `from` while graftd keeps them.

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
- `graft_init` — bootstrap or register a workspace through direct `graft init`.
- `graft_patch` — run a Graft-owned worker child with only Graft-related tools available. If the patch instruction is unclear, the child must request clarification upward instead of editing directly or creating a candidate.
- `graft_status` — inspect pi-graft convenience state and graftd status.
- `graft_ps` — show global daemon and registry status.
- `graft_doctor` — diagnose or repair registry state.
- `graft_candidate_from_scratch` — create a candidate through graftd `candidate_from_scratch`.
- `graft_validate` — validate a candidate or patch.
- `graft_admit` — admit a validated candidate as a patch.
- `graft_show` — show a candidate or patch summary.
- `graft_evidence` — list evidence for a candidate or patch.
- `graft_candidates` — list unadmitted candidates.
- `graft_search` — search admitted patches.
- `graft_materialize` — plan or materialize an admitted patch target; dry-run defaults to true.
- `graft_repo` — manage configured repositories with the current `repo add/list/sync/lock/update` flow. `add/sync/lock/update` use daemon-owned CLI execution; `list` uses the direct local CLI path.
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

The extension talks to `$GRAFT_HOME/run/daemon.sock` (default `$HOME/.graft/run/daemon.sock`). It auto-starts `graftd` with:

```bash
graftd start --cwd <cwd> --socket "$GRAFT_HOME/run/daemon.sock"
```

Routed wire requests include `workspace_id` and `workspace_root` (the Pi cwd). The extension resolves `workspace_id` from `GRAFT_WORKSPACE` first, then from `graft --json status` / `graft_init` output, then from restored Pi session state; only an uninitialized or undiscoverable workspace falls back to `ws:default` and lets graftd report the precise routing error. Lifecycle/materialize/repo write tools route through `graftd cli_exec` with `graft --cwd <cwd> ...`; read-only query, help, bootstrap, and diagnostics paths can run the direct `graft` binary. Set `GRAFT_BIN`/`GRAFT_DAEMON_BIN` if they are not on `PATH`.

The current implementation is UTF-8-text first. Binary, image, and directory behavior follows the current graft scratch wire errors and should fail loudly rather than falling back to disk reads or writes.

## Risk review

Verdict: **ship as an early integrated slice, with known caveats**.

- P1 — future default tool replacement would change core Pi semantics. Current mitigation: scratch operations are explicit `graft_*` tools, while Pi built-ins remain available.
- P1 — scratch state is not durable across daemon restart, and full multi-workspace scratch isolation depends on graftd's global-daemon workspace-state support. Mitigation: scratch ids are returned from each tool and pi-graft's convenience state is optional; lost scratch ids fail through graftd wire errors instead of hidden recovery.
- P1 — current graft property/admission behavior can still require project-specific policy tuning. Mitigation: `graft_candidate_from_scratch`, `graft_validate`, and `graft_admit` are explicit separate steps; graft_read/graft_write/graft_edit/graft_delete never auto-create candidates or auto-admit.
- P2 — file kind support is text-first. Mitigation: no passthrough fallback is implemented, so unsupported file kinds fail loudly.
- P2 — integration depends on Pi's command/tool registration surface staying stable. Mitigation: `pi-graft` exports a narrow boundary type and the registration test asserts the exact commands and tools it installs.

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
