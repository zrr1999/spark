# Troubleshooting

This page covers common problems hit during local development, workspace
registration, and the release gates. For background, see
[../plans/release-roadmap.md](../plans/release-roadmap.md) and
[e2e-gate.md](./e2e-gate.md).

## Local server (`pnpm local:start`) does not start

Symptoms: `pnpm local:start` exits immediately, or `http://127.0.0.1:5173/setup`
returns connection refused.

Checks:

1. `node --version` reports `>=26 <27` and `pnpm --version` reports `>=11 <12`.
   The Spark daemon workspace pins both via `engines` and the daemon's `target` is
   `node26`.
2. `lsof -i :5173` is empty. If it is not, either stop the conflicting process
   or set `PORT=<free port>` before `pnpm local:start`.
3. `.navia/local/` is writable. Use `pnpm local:reset` to clear the
   project-local server data root before retrying.
4. If you previously set `NAVIA_SERVER_DATA_DIR`, `NAVIA_SERVER_CACHE_DIR`, or
   `NAVIA_SERVER_STATE_DIR` in your shell, unset them before
   `pnpm local:start` so the project-local defaults apply.

## `pnpm release:check` fails on `vp fmt --check .`

The gate intentionally fails on formatting drift. Run `pnpm format` (alias for
`pnpm exec vp fmt .`) to write the canonical formatting, then commit.

If `vp fmt --check` keeps reporting the same file even after `vp fmt` writes it,
your `prettier`/`vp` binary cache may be stale. Try:

```bash
pnpm install --frozen-lockfile
pnpm exec vp fmt .
pnpm exec vp fmt --check .
```

## `pnpm release:smoke` fails: "Workspace not found after web creation"

This means the simulator was able to register a runtime but the SvelteKit
workspace creation form rejected the request. The smoke driver submits
`profileSource=builtin:fresh` precisely because the default `git` profile would
require a GitHub URL.

Likely causes:

- The web app has been changed to require a different `profileSource` enum
  value. Update both the cockpit form and `scripts/spark-daemon-smoke.ts`.
- The fake Spark daemon registered a workspace with a `displayName` and
  `localWorkspaceKey` that no longer match the form's `name` / `slug` lookup
  in `findMatchingWorkspaceBinding`. Re-align the smoke fixture or relax the
  match.

## `pnpm release:e2e` fails: "Timed out waiting for runtime workspace binding"

The in-process Spark daemon registered against the server but never produced an
available `runtime_workspace_bindings` row. Common causes:

- The runtime WebSocket failed to upgrade. Check that the server printed
  `Navia web server listening on …` before the gate starts driving forms; the
  gate already waits via `waitForServer`, so this usually points at a custom
  server crash.
- Invalid or expired runtime token. Most often happens after editing
  `apps/web/src/lib/server/runtime-registration.ts`. Re-run the gate; it mints
  a fresh token per invocation.
- Workspace path missing. The gate creates the temp workspace directory before
  starting the daemon, so this only happens if `addWorkspace` is later changed
  to require a non-empty repo. Inspect the Spark daemon DB under the printed Spark daemon
  HOME (use `--keep-data`).

## `pnpm release:e2e` fails: "Timed out waiting for the Spark daemon to mark the invocation as succeeded"

The daemon accepted the command but never produced a `succeeded`
`invocation.updated` envelope. Inspect:

- `--keep-data` and look at
  `<server-data>/navia.sqlite` → `mirrored_invocations` and
  `invocation_log_chunks` tables. A stuck `running` row usually means the
  injected `runPiPrompt` did not return.
- For `--real-pi`, raise `--task-timeout-ms` and confirm the Spark daemon data
  directory has Pi credentials. Run the daemon manually with
  `SPARK_DAEMON_HOME=… pnpm run spark-daemon:cli -- daemon start` and inspect the logs.
- For stubbed-Pi mode, check the daemon log under
  `<spark-daemon-state>/logs/daemon.jsonl` for `daemon.error` outbox rows.

## `pnpm release:e2e` fails: "Expected at least one task graph task referencing invocation"

The daemon emitted a `task_graph.snapshot`, but no row references the runtime
invocation id. This usually means the daemon and the test are disagreeing on
which id is "the" invocation id:

- `mirrored_invocations.id` is the server-side row id.
- `mirrored_invocations.runtime_invocation_id` is the id the Spark daemon generated,
  and it is what `task_graph_tasks.run_ids_json` references.

Always check `task_graph_tasks` against `runtime_invocation_id`, not the
server-side row id.

## Workspace registration prompts for a directory in CI

Plain interactive `spark-daemon workspace register` prompts on TTY if no path is provided.
Scripted registration with `--server-url`, `--token`, or `--name` defaults to
the current directory, but passing `.` explicitly can make CI logs clearer:

```bash
spark-daemon workspace register . --server-url https://… --token …
```

In CI also set `NAVIA_WORKSPACE_REGISTRATION_TOKEN` instead of `--token`
to avoid leaking the token on the command line. The CLI tests in
`apps/spark-daemon/src/cli.test.ts` cover this code path.

## `node:sqlite` warning during `pnpm build`

The SvelteKit adapter prints:

```
"node:sqlite" is imported by ".svelte-kit/adapter-node/chunks/db.js", but
could not be resolved – treating it as an external dependency.
```

This is expected: `node:sqlite` is a built-in module in Node >= 22, and the
adapter does not need to bundle it. The build still succeeds.

## Where to file new troubleshooting notes

If you hit something that surprised you on a clean repo checkout, append a
short section here with the symptom, the root cause, and the fix. Keep notes
to ~1 paragraph each so the page stays scannable; longer post-mortems belong
under `docs/research/` or `docs/rfcs/`.
