# pi-graft

`pi-graft` is a Pi extension package for graft-backed editing workflows. It is loaded by the pi-spark root package and replaces Pi's `read`, `write`, and `edit` tools with scratch-backed variants.

## Mental model

`pi-graft` does not edit the working tree directly. It talks to per-workspace `graftd` and mutates an in-memory graft scratch graph:

```text
/graft-open <base> -> scratch:a
read/write/edit    -> scratch:b/c/...
graft_promote      -> candidate:...
graft_validate     -> evidence
graft_admit        -> patch:...
/graft-close       -> release lease + clear active state
```

A scratch is daemon-instance-scoped. If `graftd` restarts, the active scratch is gone; the extension reports `E_SCRATCH_LOST` and you must reopen with `/graft-open <base>`.

## Commands

- `/graft-open <base>` — open and pin a graft scratch from a tree/candidate/patch base.
- `/graft-close` — release the active lease, attempt to drop the active scratch, and clear session state.

## Tools

### Replaced file tools

- `read` — read a UTF-8 text file from the active scratch and return `LINE#HASH:` anchors.
- `write` — write complete UTF-8 text content into the active scratch and advance the active scratch id.
- `edit` — apply strict hashline edits to the active scratch and advance the active scratch id.

`edit` intentionally rejects legacy `oldText`/`newText` exact replacement. Call `read` first, then use anchors from its output. Supported edit operations are `replace`, `append`, and `prepend`.

### Graft lifecycle tools

- `graft_status` — inspect active scratch, lease, daemon status, and changed paths.
- `graft_promote` — promote the active scratch to a candidate. This does not validate or admit automatically.
- `graft_validate` — run graft validation for a candidate/patch through graftd `cli_exec`.
- `graft_admit` — admit a validated candidate through graftd `cli_exec`.

## Runtime assumptions

The extension talks to `.graft/graftd.sock`. It auto-starts `graftd` with:

```bash
graftd start --cwd <cwd> --socket <cwd>/.graft/graftd.sock
```

Set `GRAFT_DAEMON_BIN` if `graftd` is not on `PATH`.

The current implementation is UTF-8-text first. Binary, image, and directory behavior follows the current graft scratch wire errors and should fail loudly rather than falling back to disk reads or writes.

## Risk review

Verdict: **ship as an early integrated slice, with known caveats**.

- P1 — default tool replacement changes core Pi semantics. Mitigation: every replaced tool requires an active scratch and fails with an explicit `/graft-open` hint instead of silently touching disk.
- P1 — scratch state is not durable across daemon restart. Mitigation: active state is restored from Pi session entries when possible and validated before tool use; lost scratch reports `E_SCRATCH_LOST`.
- P1 — current graft property/admission behavior can still require project-specific policy tuning. Mitigation: `graft_promote`, `graft_validate`, and `graft_admit` are explicit separate steps; read/write/edit never auto-promote or auto-admit.
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
