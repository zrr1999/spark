# RFC: Navia CLI workspace command surface

Status: draft
Date: 2026-05-25

## Summary

Navia ships a single user-facing binary, `navia`. This RFC defines the
local workspace CLI: how a user registers a workspace with a Navia server,
inspects local workspace state, pauses an attached workspace, and manages
the Spark daemon when troubleshooting.

The CLI lives entirely on the Spark daemon side of the
`spark-daemon-protocol-rfc.md:1` boundary. It does not authenticate against
servers as an owner and does not write to server-owned tables. Instead,
`ws register` presents a user-facing workspace registration token to the
Spark daemon. The token carries a server-side grant to create or link
one server-visible workspace and bind it to this Spark daemon. For v0.1
this registration is treated as permanent, with no removal command.

The CLI is almost stateless. It does not persist a `default workspace`,
does not maintain user preferences in v0.1, and resolves the workspace
to act on from `--workspace` flag or `cwd` only. Persistent state lives
in the local Spark daemon's SQLite database and in the daemon's
outbound WebSocket sessions to servers.

This RFC depends on:

- `architecture-sketch.md` for the workspace/project ownership model and
  the workspace profile shape.
- `spark-daemon-protocol-rfc.md` for Spark daemon-server enrollment, outbound WS
  semantics, capability summary, and the v0.1 single-owner-binding rule.
- `data-model-rfc.md` for server-side table layout. The CLI does not
  touch server-side tables; this dependency is referenced only to
  contrast with the new daemon-local schema.

It does not cover the `session`, `auth`, `models`, `bench`, or
`--mode rpc` command groups. Those will be defined in companion RFCs.

## Goals

- Make `navia` usable as a thin local workspace CLI that talks only to the
  local daemon over a unix socket.
- Keep the user-facing command surface to a small, learnable set:
  register, list, show, stop; plus a `daemon` subgroup for explicit
  process management.
- Define a daemon-local SQLite schema for workspace registrations,
  workspace registration grants, server-scoped runtime credentials, and
  server bindings, separate from the server schema.
- Define a workspace status state machine that distinguishes "user
  paused", "server unreachable", and "daemon not running" without
  blurring them into a single `offline`.
- Keep wire/protocol vocabulary (`runtime`, `binding`, `Spark daemon`)
  out of the user-facing workspace CLI. Those terms remain valid in
  protocol/database sections of this RFC and companion RFCs, but the
  CLI presents them as workspace, Spark daemon, and connection.

## Non-goals

- Server-side concepts outside the registration path: owner sessions,
  generic owner-mediated workspace lifecycle, web UI rendering, or
  server SQLite schema. The server-side workspace creation/binding
  caused by `ws register` is in scope as a protocol effect, not as
  direct CLI database access.
- Workspace deletion. v0.1 treats every successful `ws register` as
  permanent. Removal will be defined in a follow-up RFC and requires
  a server-side delete primitive that does not exist yet.
- Daemon process lifecycle internals (idle exit timing, supervised
  service install, lockfile format). The CLI surface for daemon is
  defined here; internals are deferred to a `daemon-lifecycle-rfc.md`.
- Remote Spark daemon attach (CLI on machine A talking to daemon on machine
  B). v0.1 only supports a local daemon over the local unix socket.
- A CLI configuration file. v0.1 does not introduce
  `~/.config/navia/cli.toml`; the CLI is stateless. Future RFCs may
  add display preferences.
- TUI keybindings, slash commands, and inbox views inside the TUI.
- The `bench`, `session`, `auth`, `models`, `acp`, and `--mode rpc`
  command groups.

## Product boundary

The product term in CLI output and help text is **workspace**. The
terms `Spark daemon`, `binding`, and `runtime` do not appear in the
user-facing `ws` command surface. When the CLI needs to expose the
implementation boundary, it says **Spark daemon** and
**connection**. The `daemon` subgroup is explicit troubleshooting
territory and may use the term `daemon` for process management.

The CLI is a **local workspace** tool. The split that matters for this
RFC:

- CLI: presents a command surface, talks to the local daemon over a
  unix socket. No persistent state of its own in v0.1.
- Daemon: a single local process per host. Owns the daemon-local
  SQLite database and one outbound WebSocket session per server it has
  registered workspaces with. Stable across CLI invocations.
- Server: implements `spark-daemon-protocol-rfc.md`. Server-side owner
  authentication, generic workspace lifecycle, and projection for the
  web UI are out of scope for this RFC. The server does consume the
  workspace registration grant, create or link the server-visible
  workspace, and record the owner binding. The CLI never holds owner
  credentials; the daemon stores only server-scoped runtime credentials
  and workspace grant metadata needed for reconnect/reconciliation.

The unit of registration is the **workspace**, not the Spark daemon.
`spark-daemon-protocol-rfc.md:21` allows one Spark daemon to manage multiple
workspaces; v0.1 presents that as "register a workspace" every time.
Internally, the first workspace registered with a server may also
establish or refresh a daemon-level runtime credential for that server.
Subsequent workspaces on the same server reuse that runtime credential
and consume only a workspace registration grant. There is no
user-visible "register the service globally first, then add workspaces"
two-step flow. A Spark daemon with no registered workspaces is simply
idle.

## Workspace permanence

Successful `ws register` is permanent for v0.1.

- The CLI has no `ws rm` or equivalent.
- The daemon-local schema has no `archived_at` / `removed_at`
  columns.
- A registered workspace can be `stop`-ed (paused, see `ws stop`)
  but the row, the path, the profile reference, and the local token
  records remain.
- Server-initiated deletion is not implemented in v0.1, so the
  daemon does not need to handle a "workspace removed by server"
  event. When v0.1's server learns to delete workspaces, the
  protocol addition (`workspace.removed` event plus reconnect-time
  reconciliation) and the corresponding Spark daemon-side cleanup will be
  defined in a follow-up RFC.

The success message of `ws register` should make permanence visible
without alarming the user. See the `ws register` section.

## Workspace resolution order

When a CLI command needs to act on a workspace and no `--workspace`
flag is given, resolution is two steps:

1. Explicit `--workspace <name>[@<server>]` flag.
2. `cwd` is at or below the local path of exactly one registered
   workspace. Symlinks are resolved with `realpath` on both sides
   before comparison.

If neither matches, the command fails with guidance specific to the
situation. There is no "default workspace" fallback; the CLI is
stateless.

If `cwd` is at or below **more than one** registered workspace's
local path, the command refuses and asks for `--workspace`. Two
ways this can happen in v0.1:

- The same local path is registered with two different servers.
  Allowed by the path uniqueness rule (see `Constraints`).
- A nested registration that a future schema relaxation might
  permit. v0.1 forbids nesting at registration time.

When `--workspace <name>` resolves to more than one workspace
(same name on different servers), the command refuses and lists
the candidates with their `<name>@<server>` form.

## Command surface

```text
spark daemon workspace register
   [path]
   --server-url <url>
   --token <workspace-registration-token>
   --name <name>
   [--profile <path-or-git-url>]
   [--yes]

spark daemon workspace                                 # alias for `ls`
spark daemon workspace ls    [--json] [--all] [--full]
spark daemon workspace show  [name[@server]] [--json]
spark daemon workspace stop  <name[@server]>  [--yes]

spark daemon                                    # help
spark daemon status   [--json]
spark daemon start
spark daemon stop     [--yes]
spark daemon restart
spark daemon logs     [--follow] [--lines <n>]

spark daemon workspace                                        # alias of `spark daemon workspace`
```

Deferred:

- `spark daemon workspace rm` (removed entirely from v0.1; see `Workspace
permanence`).
- `spark daemon workspace use` (no default workspace concept in v0.1).
- `spark daemon workspace add` (subsumed by `ws register` because v0.1 has no
  global Spark daemon-server registration).
- `spark daemon workspace rename`, `spark daemon workspace sync-profile`, remote attach
  commands.

### Common conventions

- All commands accept `-h` / `--help`. Help text always shows one
  example.
- Commands accept `--json` where listed. JSON output is a stable
  schema (see `JSON output schema`).
- Destructive commands (`stop`, `daemon stop`) require an
  interactive confirmation. `--yes` skips the prompt for scripted
  use, but never escalates the scope of the action.
- Workspace identifier syntax is `<name>` when unambiguous,
  `<name>@<server>` to disambiguate. `<server>` may be the full
  `--server-url` string or a unique prefix; if a prefix matches
  more than one registered server, the command refuses.
- `name` and `slug` are coupled in v0.1. `slug` is computed from
  `name` at registration and is unique per server. Lookups accept
  either form.
- Exit codes:
   - `0` success.
   - `1` user error (bad args, ambiguous name, unknown name).
   - `2` environment failure (daemon unreachable, SQLite locked,
     socket path missing).
   - `3` conflict (path collision, nested registration, server
     refused the workspace registration grant).
   - `4` confirmation declined.

## `spark daemon workspace register`

The only v0.1 user-facing command that registers a workspace. Internally,
successful registration creates or links the server-visible workspace and
its owner binding.

Form 1, scripted (the form most users will see, since workspace
registration tokens are pasted from the server UI):

```text
$ spark daemon workspace register . \
    --server-url http://127.0.0.1:5173 \
    --token navia_wsreg_hjrypmwfkQmw8H5tAPENRejC977q-RA_LBObrFfwgQw \
    --name navia
✓ workspace 'navia' registered
   path     ~/workspace/navia-dev/navia
   server   http://127.0.0.1:5173
   status   online
   note     v0.1 has no removal command; this registration is permanent.
```

Form 2, interactive (the user typed `spark daemon workspace register` with
nothing else; the CLI prompts):

```text
$ spark daemon workspace register
  path [./]: _
  server URL: http://127.0.0.1:5173
  workspace registration token: navia_wsreg_…  # echoed masked
  workspace name [navia]: _
  use profile from ./navia-profile? [Y/n]: _   # only when detected
  ✓ workspace 'navia' registered
    ... (same as above)
```

Token sources, in priority order:

1. `--token <value>` on the command line.
2. `--token -` reads the token from stdin (one line, trimmed).
3. `NAVIA_WORKSPACE_REGISTRATION_TOKEN` environment variable.

Tokens must not be embedded in the `--server-url` value. If the
URL contains a `token`, `registration`, or `enrollment` query
parameter, `register` refuses and prints guidance to pass
`--token` separately. This avoids shell-history exposure when users
paste a URL copied from a browser address bar.

The token is a **workspace registration grant**, not a user-visible
Spark daemon/runtime credential. Internally, the server may exchange the
first grant used by a daemon for a server-scoped runtime credential;
that credential is reused for later workspace registrations on the
same server.

Defaults and inference:

- `path` defaults to `cwd` if omitted.
- `name` defaults to the basename of the resolved real path.
- `slug` is derived from `name`: lowercase ASCII, non-alphanumerics
  to `-`, collapsed runs, trimmed. Slug uniqueness is per server,
  not global.
- Profile detection: looks for `./navia-profile/settings.toml` then
  `./.navia/profile.toml` under the registered path. If found, the
  interactive form asks once whether to import; the scripted form
  imports only if `--profile <ref>` is given.
- Profile import is one-shot at registration. The Spark daemon records
  the source ref and resolved git commit; subsequent profile
  changes do not affect this workspace until a future
  `sync-profile` command lands.

Constraints (rejected with exit 3):

- The path must exist and be a directory.
- The path must not already be registered with the **same**
  server. Same path on a **different** server is allowed; this is
  the v0.1 rule for "same code, two servers".
- The path must not be inside or above another registered
  workspace's path on **any** server. Nesting is forbidden across
  servers because the conflict is physical (worktree, leases),
  not logical.
- The path must be readable by the daemon process.
- The slug derived from `name` must not collide with an existing
  workspace on the same server. Collisions are rejected; the
  user picks a different `--name`.
- The server URL must be reachable, and the daemon must be able to
  open an outbound WebSocket session and complete workspace
  registration with the supplied token. If registration fails, the
  daemon-local row
  is rolled back so a failed registration leaves no trace.

Side effects:

1. CLI calls the local daemon over the unix socket with the
   registration intent. (If the daemon is not running, the CLI
   lazy-spawns it; see `Daemon process`.)
2. Daemon opens or reuses its outbound WS to the server. If this is
   the daemon's first workspace for that server, it exchanges the
   workspace registration grant for a server-scoped runtime
   credential. If the daemon already has a valid runtime credential
   for that server, it reuses it and presents the token only as a
   workspace grant.
3. Server consumes the workspace grant, creates or links the
   server-visible `workspaces` row, creates the owner binding for
   this local workspace, and returns the server workspace id,
   binding ref, and initial binding status. Mechanics live in
   `spark-daemon-protocol-rfc.md`; this RFC only defines the local command
   surface and the local persistence that observes that protocol.
4. Daemon writes daemon-local rows in a single transaction:
   `daemon_servers` (or reuses an existing row),
   `daemon_server_credentials` (server-scoped runtime credential
   metadata), `daemon_workspaces`, and `daemon_workspace_grants`.
   Raw tokens are discarded after successful exchange/consume; only
   hashes and server-issued ids are persisted.
5. Daemon acks back to the CLI with the new workspace's identity
   and initial status.
6. On any daemon-side failure (server unreachable, token rejected,
   schema constraint), the daemon rolls back its transaction and
   reports failure to the CLI; the CLI prints a remediation hint.

The transaction boundary is **inside the daemon**, not split
between CLI and daemon. This is the most important departure from
earlier drafts of this RFC: the CLI is a thin RPC client and does
not write SQLite directly.

Permanence is shown once in the success message (`note    v0.1
has no removal command; this registration is permanent.`). It
does not appear on every subsequent command. The CLI does not
require the user to type "I understand" or similar.

## `spark daemon workspace` / `spark daemon workspace ls`

Bare `spark daemon workspace` is sugar for `spark daemon workspace ls`.

Default tabular output:

```text
$ spark daemon workspace
NAME      SERVER                       STATUS                   PATH                                  PROJECTS  INBOX  LAST SESSION
navia     http://127.0.0.1:5173        online                   ~/workspace/navia-dev/navia           1         0      2 h ago
paddle    http://127.0.0.1:5173        degraded                 ~/code/paddle                         3         2      12 min ago
nyako     https://navia.example.com    offline · disconnected   ~/workspace/zrr1999/nyako             —         —      —
```

Columns:

- `NAME`: human label. When the same name is registered on multiple
  servers, the rows still each show the bare name in this column;
  identifier syntax for other commands uses `<name>@<server>` for
  disambiguation.
- `SERVER`: server URL. Truncated to terminal width with ellipsis
  if long; `--full` prints in full.
- `STATUS`: one of `online | starting | degraded |
offline · detached | offline · disconnected | offline · service stopped`
  (see `Workspace status state machine`).
- `PATH`: registered local path. Renders with `~` shorthand by
  default; `--full` produces absolute paths.
- `PROJECTS`: project count from the daemon's view. `—` if the
  workspace has never been online or counts are unknown.
- `INBOX`: unresolved inbox item count.
- `LAST SESSION`: relative time of the most recent session
  activity in this workspace.

Behavior:

- Reads from the daemon over the local socket. If the daemon is
  not running, lazy-spawns it; if lazy-spawn fails (lock held by
  another non-running pid, write permission denied on socket
  path), the command exits 2 with a `spark daemon status` hint.
- `--all` includes workspaces that have been `stop`-ed. Without
  `--all`, those are still shown but with status
  `offline · detached`. v0.1 has no archived state, so `--all`
  has no effect on workspace removal (there is no removal); it
  is reserved for a future archived state.
- Empty registry prints:
   ```text
   no workspaces registered.
     spark daemon workspace register . --server-url <url> --token <tok> --name <ws>
   ```
- `--json` emits the schema below.

## `spark daemon workspace show [name[@server]]`

Detailed view of a single workspace.

```text
$ spark daemon workspace show paddle
paddle
  status         online
  server         http://127.0.0.1:5173
  path           ~/code/paddle
  profile        paddle-dev @ 4f3a1c2 (imported 2 days ago)
  connection     conn_01J… · attached 12 min ago

projects (3)
  release-v3            running    2 open tasks · 1 ask · last run 5 min ago
  docs-overhaul         planned    no active runs
  perf-benchmarks       blocked    1 high-urgency ask

inbox (2 unresolved)
  ask:7a2e   "approve diff in foo.cc"          urgency: high   3 min ago
  review:b1  "review benchmarks/run-2025-05"   urgency: med    1 h ago

recent sessions (5)
  8c2f  release-v3   gpt-5-codex   12 min ago   active
  92ab  release-v3   gpt-5-codex   2 h ago      ended
```

Behavior:

- Without a `name`, `show` requires `cwd` to resolve to exactly one
  workspace. Otherwise it asks for `--workspace`.
- `connection` line is diagnostic; it shows the Spark daemon's
  workspace connection id without exposing protocol vocabulary.
- When `status` is `degraded`, a `why` block and `remediation`
  block appear (see `Degraded reasons`).
- When `status` starts with `offline ·`, the section about
  projects/inbox/recent sessions still renders from the daemon's
  cached projection but is marked `(stale, last refreshed 2 h
ago)` if the daemon has been disconnected for over a minute.
- `--json` emits the schema below.

## `spark daemon workspace stop <name[@server]>`

Pauses an attached workspace. The daemon keeps any server-level
outbound WS open, but marks this workspace binding as paused/detached
and stops accepting routed commands for that workspace. Other
workspaces on the same daemon process and the same server are
unaffected.

```text
$ spark daemon workspace stop paddle
✓ paused 'paddle'
   server         http://127.0.0.1:5173
   path           ~/code/paddle (untouched)
   sessions       3 ended; will resume on next attach
   reattach       cd into ~/code/paddle and run navia,
                  or pass --workspace paddle to any command
```

Behavior:

- Requires the daemon reachable. The daemon performs a graceful
  detach (drains in-flight tool calls with a 30 s soft timeout,
  then forces detach). Exits 2 with `spark daemon status` hint
  if the daemon is unreachable.
- The server must stop routing new commands to the paused workspace
  binding once it observes the detach/paused state. This is an
  internal protocol effect; the user-facing action remains "pause
  workspace".
- The daemon-local row remains. `status` becomes
  `offline · detached`. Re-attach happens automatically the next
  time a CLI command targets this workspace.
- `stop` has no effect on the daemon process. The daemon may exit
  per its own idle policy if no other work remains, but that is
  governed by `daemon-lifecycle-rfc.md` and is independent of
  `ws stop`.
- `--yes` skips the confirmation prompt.

## `spark daemon` subgroup

The `daemon` subgroup is the explicit, observable surface for the
local Spark daemon daemon process. It is **not** required for normal use:
any `ws` command that needs the daemon will lazy-spawn it. The
subgroup exists for observability, scripted service supervision,
and recovery from edge cases.

```text
$ spark daemon status
running
  pid              42137
  socket           ~/.local/state/navia/daemon.sock
  state db         ~/.local/state/navia/daemon.db
  uptime           2 h 14 min
  registered       2 workspaces across 1 server
    http://127.0.0.1:5173    2 workspaces · WS connected · last heartbeat 4 s ago
```

```text
$ spark daemon status                    # when not running
not running
   socket           ~/.local/state/navia/daemon.sock (absent)
   start            spark daemon start          # foreground, stay attached
                    or run any 'spark daemon workspace' command to lazy-spawn
```

Subcommands:

- `daemon status`: prints the table above. `--json` emits the
  schema in `JSON output schema`. Never lazy-spawns: if not
  running, it says so.
- `daemon start`: runs the daemon in the foreground of the
  current terminal. Used for service-unit supervision and for
  debugging. Does nothing different from a lazy-spawned daemon
  internally; the lockfile + socket guarantee a single instance
  across all entry paths.
- `daemon stop`: asks the running daemon to drain attached
  workspaces, close outbound WSs, and exit. `--yes` skips
  confirmation.
- `daemon restart`: equivalent to `stop` then `start`. Does not
  lazy-spawn; if no daemon was running, it starts one.
- `daemon logs`: tails the daemon's log file. `--follow` streams,
  `--lines <n>` shows last n lines (default 100).

The user-facing default is still that no one ever needs to type
`spark daemon` for routine work. The subgroup exists, named after
what it actually is, because hiding it harms the user the moment
something goes wrong.

## First-run flow

When a user runs `navia` (or any command that needs a workspace)
with no workspaces registered:

```text
$ navia
no workspaces registered.
  spark daemon workspace register . --server-url <url> --token <tok> --name <ws>
or pass --workspace <name> after registering one elsewhere.
```

When a user runs `navia` from a `cwd` that is not under any
registered workspace's path, but at least one workspace exists:

```text
$ navia
/Users/zrr/somewhere is not under a registered workspace.
  spark daemon workspace register .  --server-url <url> --token <tok> --name <ws>
or cd into a registered workspace, or pass --workspace <name>.
existing workspaces:
  navia    http://127.0.0.1:5173
  paddle   http://127.0.0.1:5173
```

When `cwd` resolves to exactly one registered workspace:

- The daemon is lazy-spawned if not running.
- That workspace is attached if `offline · detached`.
- The TUI starts.

There is no hidden setup step before the user explicitly chooses to
register a workspace. The user must paste a server URL and a workspace
registration token at least once to do useful work.

## Naming

For v0.1, `name` and `slug` are coupled per workspace. `slug` is
computed from `name` at registration and is unique within the
scope of a single server.

- `name` is the user label shown in `ls` / `show` and used in
  `<name>[@<server>]` identifier syntax.
- `slug` is the protocol-stable identifier sent over the WS and
  stored in the daemon's binding records.
- Cross-server collisions are allowed: the same `name` on two
  servers is two distinct workspaces. Identifier syntax requires
  `@<server>` only when ambiguous.
- `<server>` in identifier syntax accepts the full URL string or
  a unique prefix. The daemon stores server URLs verbatim; prefix
  matching is a CLI convenience.

`rename` is deferred from v0.1 because changing one of these
requires migrating slug references in artifact paths, projection
ids, and event logs.

## Constraints and conflicts

Enforced by `ws register`:

- **Path uniqueness, scoped per server**: a given resolved real
  path can be registered under at most one workspace per server.
  The same path under two different servers is allowed and is the
  intended way to bind one local checkout to multiple Navia
  servers (e.g. personal and work).
- **No nested workspaces, across all servers**: if path A is
  registered with any server, neither a parent nor a child of A
  may be registered with any server. The conflict is physical
  (worktree, leases, lockfiles), so it does not split by server.
- **Path must be a real directory**: paths are resolved with
  `realpath` before comparison and registration. cwd resolution
  also uses `realpath`, so symlink farms (e.g. macOS `/var` →
  `/private/var`) match correctly.
- **Slug uniqueness per server**: derived slug must not collide
  with an existing slug on the same server. Cross-server slug
  collisions are allowed.
- **Server reachability and workspace registration success**: the daemon must
  successfully register the workspace with the server using the
  supplied token before the registration is committed. Registration
  failure rolls
  back the local transaction.

## Workspace status state machine

```text
                 first register / reattach
   any offline ──────────────────────► starting
                                          │
                                  capability check
                                          │
                              ┌───────────┴───────────┐
                              │                       │
                              ▼                       ▼
                            online                degraded
                              │                       │
                              └───────────┬───────────┘
                                          │
                                ┌─────────┴─────────┐
                                │                   │
                       user `ws stop`        connection lost
                                │                   │
                                ▼                   ▼
                  offline · detached      offline · disconnected

                  daemon process exit (any state) ─► offline · service stopped
```

States, exhaustively:

- **online**: daemon running; outbound WS to this workspace's
  server connected; this workspace is attached; capability checks
  pass.
- **starting**: daemon running; this workspace is attaching
  (initial register, reattach after `stop`, or reconnect after
  disconnect). Bounded by a daemon-side timeout; transitions to
  `online` or `degraded`.
- **degraded**: daemon running, WS connected, workspace attached,
  but at least one capability subsystem is unhealthy. Tools that
  depend on the failing subsystem fail; others succeed. See
  `Degraded reasons`.
- **offline · detached**: user ran `ws stop`. Re-attach happens
  on next access.
- **offline · disconnected**: daemon running, but the outbound WS
  to this workspace's server is not connected (server down,
  network broken, runtime credential rejected). Re-attach is automatic
  once the WS recovers.
- **offline · service stopped**: Spark daemon process is not running. Common
  before the first `ws` command of a CLI session. Resolves on
  lazy-spawn or `daemon start`.

State transitions are owned by the daemon. The CLI observes them
through the unix socket.

### Why the offline reasons are split

Earlier drafts had a single `offline` state with a free-text
explanation. Splitting into three named sub-statuses serves three
concrete uses:

- `offline · detached`: user expected this; no remediation needed;
  re-attach is automatic on access.
- `offline · disconnected`: this is a transient or recoverable
  fault; the daemon retries on its own; user may want to check
  server reachability or token validity.
- `offline · service stopped`: lazy-spawn will resolve it on next CLI
  command; users who have explicit service supervision want to
  see this distinct from a server-side problem.

These map to a single `offline` line in compact `ls` output
(prefixed with the reason after `·`) and to a structured
`offlineReason` field in `--json`.

### Degraded reasons

The daemon reports degraded workspaces with a structured list of
reason codes. The CLI renders each with a one-line description
and a remediation hint. v0.1 set:

| Code                           | Meaning                                                              | Self-heal? |
| ------------------------------ | -------------------------------------------------------------------- | ---------- |
| `filesystem.unreachable`       | Registered path is missing or returns ENOENT.                        | yes        |
| `filesystem.permission`        | Daemon cannot read/write the workspace path.                         | no         |
| `git.corrupt`                  | Bound git repo has corrupt or missing HEAD/worktree.                 | no         |
| `profile.invalid`              | Imported profile fails schema validation or refers to missing files. | no         |
| `profile.missing-agents`       | Profile references agent ids whose definition files are missing.     | no         |
| `runtime.subprocess-unhealthy` | Pi SDK or other subsystem subprocess has been failing health checks. | yes        |
| `lease.stale`                  | Stale Spark daemon lease found from a prior crash; needs cleanup.          | yes        |
| `storage.full`                 | XDG cache/state/data partition is full.                              | yes        |
| `storage.io-error`             | Repeated I/O errors on daemon-local SQLite or cache directory.       | no         |

Server-related faults that earlier drafts considered listing under
`degraded` are instead reported as `offline · disconnected` with
their own reason codes:

| Code                       | Surfaces under           |
| -------------------------- | ------------------------ |
| `server.unreachable`       | `offline · disconnected` |
| `server.token-rejected`    | `offline · disconnected` |
| `server.token-expired`     | `offline · disconnected` |
| `server.protocol-mismatch` | `offline · disconnected` |

The split exists because `degraded` means "attached but
partially broken" and a workspace whose WS is down is not
attached at all.

## Spark daemon-side schema sketch

This RFC introduces daemon-local tables. They live in a separate
SQLite database from the server's database, but reuse
`@zendev-lab/navia-db`'s migration framework. Naming convention prefixes
daemon-local tables with `daemon_` to avoid conflict if a future
deployment merges schemas.

The schema is a sketch; final column lists land via migration in
`packages/db`. The intent is what is normative.

```text
daemon_servers
   id                  TEXT PK
   server_url          TEXT NOT NULL UNIQUE
   first_registered_at TEXT NOT NULL
   last_connected_at   TEXT
   last_disconnect_reason TEXT
   protocol_version    TEXT

daemon_server_credentials
   id                    TEXT PK
   server_id             TEXT NOT NULL UNIQUE REFERENCES daemon_servers(id)
   runtime_id            TEXT NOT NULL
   runtime_token_hash    TEXT NOT NULL
   refresh_token_hash    TEXT
   runtime_token_expires_at TEXT
   refresh_token_expires_at TEXT
   created_at            TEXT NOT NULL
   updated_at            TEXT NOT NULL

daemon_workspaces
   id                          TEXT PK
   server_id                   TEXT NOT NULL REFERENCES daemon_servers(id)
   server_workspace_id         TEXT
   server_binding_id           TEXT
   name                        TEXT NOT NULL
   slug                        TEXT NOT NULL
   local_path                  TEXT NOT NULL
   profile_source_kind         TEXT
   profile_ref                 TEXT
   profile_commit              TEXT
   registered_at               TEXT NOT NULL
   last_known_status           TEXT NOT NULL
   last_known_offline_reason   TEXT
   last_status_changed_at      TEXT NOT NULL
   UNIQUE (server_id, local_path)
   UNIQUE (server_id, slug)

daemon_workspace_grants
   id                    TEXT PK
   daemon_workspace_id   TEXT NOT NULL REFERENCES daemon_workspaces(id)
   grant_token_hash      TEXT
   server_grant_id       TEXT
   created_at            TEXT NOT NULL
   consumed_at           TEXT
   revoked_at            TEXT
```

Notes on the sketch:

- No `archived_at` / `removed_at`. v0.1 treats workspaces as
  permanent (`Workspace permanence`).
- `server_workspace_id` is filled after the first successful
  workspace registration ack; nullable until then to make
  registration's internal transaction atomic.
- `daemon_server_credentials` is server-scoped, not workspace-scoped.
  Registering an additional workspace on the same server must not
  revoke or replace the daemon's existing runtime credential unless
  the server explicitly rotates it.
- `daemon_workspace_grants` records that a user-visible workspace
  registration grant was consumed for this workspace. It does not
  store runtime credentials.
- Token hashes only; raw tokens are never persisted.
- `last_known_status` is a denormalized cache for fast `ls`
  rendering. The authoritative status during a CLI call comes
  from the daemon's in-memory state, not this column. The column
  is updated by the daemon as state changes; CLI never writes it.
- Capability check details live in the daemon's in-memory
  per-binding state and a `binding_diagnostics` JSON column on
  some future table; this RFC does not specify that column.

The CLI does not open this database. All reads and writes go
through the daemon over the unix socket. The schema is documented
here only because the data model is part of the RFC's
acceptance.

## JSON output schema

```ts
// spark daemon workspace ls --json
type WorkspaceListItem = {
   slug: string;
   name: string;
   serverUrl: string;
   path: string; // absolute, real-path-resolved
   status: WorkspaceStatus;
   offlineReason?: OfflineReason;
   degradedReasons?: DegradedReasonCode[];
   profile?: { sourceKind: "builtin" | "git"; ref: string; commit?: string; importedAt: string };
   counts: {
      projects: number | null;
      unresolvedInbox: number | null;
      sessions: number | null;
   };
   lastSessionAt?: string; // ISO 8601
   lastStatusChangedAt: string; // ISO 8601
};

// spark daemon workspace show --json
type WorkspaceDetail = WorkspaceListItem & {
   connection: ConnectionDetail | null; // null until first attach
   projects: Array<{
      slug: string;
      name: string;
      status: string;
      openTasks: number;
      openAsks: number;
      lastRunAt?: string;
   }>;
   inbox: Array<{ ref: string; kind: string; title: string; urgency: string; createdAt: string }>;
   recentSessions: Array<{
      id: string;
      project: string;
      model: string;
      lastActivityAt: string;
      state: string;
   }>;
};

type ConnectionDetail = {
   ref: string; // Spark daemon connection identifier
   attachedAt?: string;
   capabilities: Array<{
      id: string;
      status: "online" | "offline";
      lastCheckedAt: string;
      message?: string;
   }>;
};

type WorkspaceStatus =
   | "online"
   | "starting"
   | "degraded"
   | "offline:detached"
   | "offline:disconnected"
   | "offline:service-stopped";

type OfflineReason = "detached" | "disconnected" | "service-stopped";

type DegradedReasonCode =
   | "filesystem.unreachable"
   | "filesystem.permission"
   | "git.corrupt"
   | "profile.invalid"
   | "profile.missing-agents"
   | "runtime.subprocess-unhealthy"
   | "lease.stale"
   | "storage.full"
   | "storage.io-error";

// spark daemon status --json
type DaemonStatus =
   | { running: false; socketPath: string }
   | {
        running: true;
        pid: number;
        socketPath: string;
        stateDbPath: string;
        startedAt: string;
        servers: Array<{
           url: string;
           workspaceCount: number;
           wsConnected: boolean;
           lastHeartbeatAt?: string;
           lastDisconnectReason?: string;
        }>;
     };
```

The compact textual statuses in `ls` (`offline · detached` etc.)
correspond to the dotted `offline:detached` form in JSON. The
delimiter differs because `·` is a display affordance for
humans; the JSON form is more easily filtered.

## Errors and remediation

Every CLI error follows the same shape:

```text
✗ <one-line summary>
  why     <one-line cause; concrete>
  fix     <one or two specific commands>
```

Examples:

```text
✗ cannot register workspace
  why     /Users/zrr/code/paddle is already registered as 'paddle' on http://127.0.0.1:5173
  fix     cd /Users/zrr/code/paddle and run 'navia' to use it
```

```text
✗ cannot register workspace
  why     /Users/zrr/code/paddle/sub-tool is inside workspace 'paddle' at /Users/zrr/code/paddle
          (registered with http://127.0.0.1:5173). nesting is not allowed across servers.
  fix     register a different path
```

```text
✗ cannot register workspace
  why     server rejected the workspace registration token (expired or already used)
  fix     get a fresh token from the server's web UI and try again
```

```text
✗ cannot pause workspace
  why     local navia service is not running and cannot be reached
  fix     spark daemon status        check service state
```

```text
✗ workspace 'paddle' is degraded
  why     workspace path not reachable: ENOENT at ~/code/paddle (filesystem.unreachable)
  fix     reconnect the volume, or run 'spark daemon workspace stop paddle'
```

```text
✗ ambiguous workspace name 'navia'
  why     'navia' is registered with two servers
  fix     use --workspace navia@http://127.0.0.1:5173
          or  --workspace navia@https://navia.example.com
```

User-facing copy uses `workspace`, `local navia service` (for
process management when context demands), `connection`, and `server`.
The terms `Spark daemon`, `binding`, and `runtime` are reserved for
protocol/database documentation and are not exposed by `ws` output.

## Existing protocol/database vocabulary

This RFC keeps wire/protocol vocabulary unchanged. Server-side API
routes remain `/api/v1/runtime/*`, server tables remain
`runtime_workspace_bindings`, and the binding capability summary
in `spark-daemon-protocol-rfc.md` continues to use `available |
indexing | degraded | unavailable`.

The CLI presents a smaller user-facing status set
(`online | starting | degraded | offline · detached |
offline · disconnected | offline · service stopped`). Mapping rules,
where the binding capability summary is the source:

| Server-side `runtime_workspace_bindings.status` + daemon connection state            | CLI status                          |
| ------------------------------------------------------------------------------------ | ----------------------------------- |
| `available`, all checks pass, daemon WS connected, workspace attached                | `online`                            |
| `indexing`, daemon WS connected                                                      | `starting`                          |
| `available` with at least one failing check, daemon WS connected, workspace attached | `degraded`                          |
| `degraded` (server side), daemon WS connected                                        | `degraded`                          |
| daemon WS connected, workspace was `stop`-ed by user                                 | `offline · detached`                |
| daemon running, daemon WS to this server not connected                               | `offline · disconnected`            |
| daemon process not running                                                           | `offline · service stopped`         |
| `unavailable` reported by server                                                     | `offline · disconnected`            |
| `archived` (future, server side)                                                     | (not reachable in v0.1; no removal) |

The `terminology` section in `README.md` should be updated
alongside the first implementation patch to record that the CLI
uses `workspace` as user-facing primary, while `runtime`,
`Spark daemon`, and `binding` are wire/database identifiers preserved
in protocol RFCs rather than CLI output.

## Out of scope

Explicit deferrals:

- **Workspace removal**, both Spark daemon-side and server-side.
  Future RFC will define the `workspace.removed` server-to-Spark daemon
  event, the reconnect-time reconciliation, and any user-facing
  surface (`spark daemon workspace rm` or owner-only deletion via web UI). v0.1
  registrations are permanent.
- **Daemon process lifecycle internals**: idle exit, lockfile
  format, socket trust details, supervised service install.
  `daemon-lifecycle-rfc.md`.
- **Remote Spark daemon attach**: a CLI on machine A talking to a
  daemon on machine B. v0.1 is local-socket only.
- **Workspace rename and profile sync**.
- **CLI configuration file**: `~/.config/navia/cli.toml` is not
  introduced by this RFC. No display preferences, no default
  workspace, no notification settings.
- **Device flow for token entry**. v0.1 uses paste-token flow.
- **Cross-server workspace migration**.
- **`bench`, `session`, `auth`, `models`, `acp`, and
  `--mode rpc` command groups**.

## Acceptance checks

A v0.1 implementation of this RFC is acceptable when:

- `spark daemon workspace register` registers a fresh checkout with a local
  Navia server using a paste-token flow and produces a workspace
  visible to both the daemon-local schema and the server-side
  workspace/binding tables.
- `spark daemon workspace register` enforces all path constraints: same path on
  same server rejected, same path on different server accepted,
  nested across servers rejected.
- `spark daemon workspace register` rolls back the daemon-local transaction on
  workspace registration failure, leaving no trace.
- `spark daemon workspace ls` produces the documented columns, distinguishes
  the three offline sub-statuses, and matches the JSON schema.
- `spark daemon workspace show` renders `degraded` with reason codes and
  remediation lines; renders `offline · disconnected` and
  `offline · service stopped` with their own structured offline
  reasons.
- `spark daemon workspace stop` pauses one workspace cleanly without affecting
  others on the same daemon, sets state to
  `offline · detached`, and re-attaches automatically on next
  command.
- `spark daemon status`, `start`, `stop`, `restart`, `logs` work
  as documented; lazy-spawn from a `ws` command produces a daemon
  indistinguishable from one started by `daemon start`.
- The CLI shows no `ws rm`, `ws use`, `ws add`, or any other
  removal/default command in `--help` output.
- The CLI shows no `Spark daemon`, `enroll`, or
  `binding` term in `ws` success messages or in the primary
  workspace command surface. Diagnostic `ws show` output uses
  `connection`, not protocol vocabulary.
- Cross-server workspace name collisions are resolvable via the
  `<name>@<server>` identifier syntax with prefix matching.
- The CLI does not open the daemon-local SQLite database
  directly; all reads and writes go through the daemon's unix
  socket.
- The CLI does not create or read `~/.config/navia/cli.toml`.
