# pi-graft

`pi-graft` is a Pi extension package for graft-backed editing workflows. It is loaded by the pi-spark root package, but its scratch file operations are currently experimental tools (`graft_read`, `graft_write`, and `graft_edit`) so Pi's built-in `read`, `write`, and `edit` tools remain available.

## Mental model

`pi-graft` does not edit the working tree directly. It talks to the machine-local global `graftd` at `$GRAFT_HOME/run/daemon.sock` and mutates an in-memory graft scratch graph for the attached/discovered workspace:

```text
/graft-open <base> -> scratch:a
graft_read/write/edit -> scratch:b/c/...
graft_promote      -> candidate:...
graft_validate     -> evidence
graft_admit        -> patch:...
/graft-close       -> release lease + clear active state
```

A scratch is daemon-instance-scoped. If `graftd` restarts, the active scratch is gone; the extension reports `E_SCRATCH_LOST` and you must reopen with `/graft-open <base>`. Graft v3 treats cwd as an attach/routing key, not as the workspace identity; cwd may be a Git worktree.

## Commands

- `/graft-attach [workspace-id|--status]` — attach cwd to a Graft workspace route, or show attach status. Without an argument, Graft defaults to `ws:default`.
- `/graft-detach` — remove the cwd registry route without deleting workspace repo metadata.
- `/graft-ps` — show `$GRAFT_HOME`, global daemon socket/pid, registered workspaces, routes, and repo paths.
- `/graft-doctor [--rebuild-registry]` — diagnose registry/workspace/repo-path reachability, optionally rebuilding missing machine-local workspace records from `$GRAFT_HOME/workspaces/*`.
- `/graft-open <base>` — open and pin a graft scratch from a tree/candidate/patch base.
- `/graft-close` — release the active lease, attempt to drop the active scratch, and clear session state.

## Tools

### Experimental scratch file tools

These tools do not override Pi built-ins yet. Use them explicitly while the graft workflow is being tested.

- `graft_read` — read a UTF-8 text file from the active scratch and return `LINE#HASH:` anchors.
- `graft_write` — write complete UTF-8 text content into the active scratch and advance the active scratch id.
- `graft_edit` — apply strict hashline edits to the active scratch and advance the active scratch id.

`graft_edit` intentionally rejects legacy `oldText`/`newText` exact replacement. Call `graft_read` first, then use anchors from its output. Supported edit operations are `replace`, `append`, and `prepend`.

### Graft lifecycle tools

- `graft_status` — inspect active scratch, lease, daemon status, and changed paths.
- `graft_promote` — promote the active scratch to a candidate. This does not validate or admit automatically.
- `graft_validate` — run graft validation for a candidate/patch through graftd `cli_exec`.
- `graft_admit` — admit a validated candidate through graftd `cli_exec`.

## Runtime assumptions

The extension talks to `$GRAFT_HOME/run/daemon.sock` (default `$HOME/.graft/run/daemon.sock`). It auto-starts `graftd` with:

```bash
graftd start --cwd <cwd> --socket "$GRAFT_HOME/run/daemon.sock"
```

Each wire request includes `workspace_id` (from `GRAFT_WORKSPACE`, default `ws:default`) and `cwd`; `graft_validate`/`graft_admit` still route through `graftd cli_exec` with `graft --cwd <cwd> ...`. Set `GRAFT_DAEMON_BIN` if `graftd` is not on `PATH`.

The current implementation is UTF-8-text first. Binary, image, and directory behavior follows the current graft scratch wire errors and should fail loudly rather than falling back to disk reads or writes.

## Risk review

Verdict: **ship as an early integrated slice, with known caveats**.

- P1 — future default tool replacement would change core Pi semantics. Current mitigation: scratch operations are experimental `graft_*` tools, while Pi built-ins remain available.
- P1 — scratch state is not durable across daemon restart, and full multi-workspace scratch isolation depends on graftd's global-daemon workspace-state support. Mitigation: active state is restored from Pi session entries when possible and validated before tool use; lost scratch reports `E_SCRATCH_LOST`.
- P1 — current graft property/admission behavior can still require project-specific policy tuning. Mitigation: `graft_promote`, `graft_validate`, and `graft_admit` are explicit separate steps; graft_read/graft_write/graft_edit never auto-promote or auto-admit.
- P2 — file kind support is text-first. Mitigation: no passthrough fallback is implemented, so unsupported file kinds fail loudly.
- P2 — integration depends on Pi's command/tool registration surface staying stable. Mitigation: `pi-graft` exports a narrow boundary type and the registration test asserts the exact commands and tools it installs.

## Validation

Focused static check:

```bash
pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --strict --skipLibCheck --types node --allowImportingTsExtensions packages/pi-graft/src/extension.ts packages/pi-graft/src/index.ts packages/pi-graft/src/extension-entry.ts test/pi-graft-extension.test.ts
```

Default test (real graftd E2E skipped unless opted in):

```bash
node --experimental-strip-types --test test/pi-graft-extension.test.ts
```

Real graftd E2E:

```bash
PI_GRAFT_E2E=1 node --experimental-strip-types --test test/pi-graft-extension.test.ts
```
