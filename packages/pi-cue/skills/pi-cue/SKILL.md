---
name: pi-cue
description: |
  Use cue-shell as the only execution backend (bash is disabled).
  cue-shell uses direct-exec with its own composition operators:
  |> pipes stdout, -> runs in serial on success, || runs in parallel,
  ~> runs in serial ignoring failures.
  Use run for ALL commands: quick ones (ls, cat, grep), builds, tests,
  servers, and background jobs.  status/wait to track, kill to stop,
  cron for scheduled tasks.  cue-shell has its own grammar — not bash-compatible.
---

# pi-cue

**The bash tool is disabled. cue-shell is the only command execution tool.**

Use `run` for ALL commands — quick filesystem operations (ls, cat, grep),
builds, test suites, dev servers, and long-running background processes.
The extension automatically passes the current working directory (cwd) to
each command via `:run(cwd=...)` mode param.

## Tool reference (8 tools, organized by category)

| Category   | Tool     | Purpose                                    | Key parameters                                                          |
| ---------- | -------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| **Job**    | `run`    | Create and execute a job                   | `command`, `background?`, `timeout?`, `cwd?`, `tail?`                   |
| **Job**    | `jobs`   | List jobs                                  | `status?` (running/pending/done/failed/killed)                          |
| **Job**    | `status` | Inspect job/cron — state + stdout + stderr | `id` (J<n> or C<n>), `tail_bytes?`                                      |
| **Job**    | `kill`   | Terminate job or remove cron               | `id` (J<n> or C<n>)                                                     |
| **Job**    | `wait`   | Block until job reaches terminal state     | `id` (J<n>), `timeout?`                                                 |
| **Cron**   | `cron`   | Unified cron management                    | `action` (add/list/pause/resume/remove), `schedule?`, `command?`, `id?` |
| **System** | `scopes` | List environment scopes + HEAD env         | _(none)_                                                                |
| **System** | `log`    | Show history for a job/cron or full log    | `id?`                                                                   |

Tool names correspond directly to category operations on the three core objects
(Jobs, Crons, Scopes). See `ARCHITECTURE.md` for the categorical model.

## How cue-shell works

cue-shell is direct-exec (execvp) — each command word is looked up in `PATH`
and invoked as a process. It has its own grammar (not bash-compatible)
with native composition operators.

### Composition operators

**Pipeline operators** (inside a single job, connect stdin/stdout):

| Operator | Effect                          | Example                     |
| -------- | ------------------------------- | --------------------------- |
| `\|>`    | Pipe stdout → next stdin        | `echo hello \|> wc -w`      |
| `\|&>`   | Pipe stdout+stderr → next stdin | `make \|&> tee build.log`   |
| `\|!>`   | Pipe stderr-only → next stdin   | `cargo test \|!> grep FAIL` |

**Chain operators** (between jobs — each step is tracked individually):

| Operator | Effect                                      |
| -------- | ------------------------------------------- |
| `->`     | Run next only if previous succeeds (exit 0) |
| `~>`     | Run next regardless of previous exit code   |
| `\|\|`   | Run both concurrently                       |
| `\|\|?`  | Run concurrently, stop when first succeeds  |

### Precedence and grouping

```text
pipe (|>)  >  parallel (||)  >  serial (->)

a |> b -> c || d    =    (a |> b) -> (c || d)
```

Group with `()` for explicit precedence:

```text
run(command="(cargo build || cargo audit) -> cargo test")
```

**⚠️ `run(xxx)` ≠ `run (xxx)`** — parentheses immediately after
`:run` are parsed as mode parameters. Always put a space before `(`
for chain grouping:

```text
✅  run(command="(sleep 0.5 || echo fast) -> echo done")
```

### Converting from shell syntax

| Shell                      | cue-shell        |
| -------------------------- | ---------------- |
| `cmd1 && cmd2`             | `cmd1 -> cmd2`   |
| `cmd1 \|\| cmd2`           | `cmd1 ~> cmd2`   |
| `cmd1 & cmd2` (background) | `cmd1 \|\| cmd2` |
| `cmd1 \| cmd2`             | `cmd1 \|> cmd2`  |
| `cmd1 2>&1 \| cmd2`        | `cmd1 \|&> cmd2` |

---

## Common command patterns

### Build and test

```text
run(command="cargo build |> grep -E 'error|warning'")
run(command="cargo build -> cargo test")
run(command="cargo clippy || cargo test")
run(command="(cargo build || cargo audit) -> cargo test")
```

### File operations

```text
run(command="ls -la docs/")
run(command="cat README.md")
run(command="find . -name '*.rs' |> head -20")
```

### Long output commands (auto-truncated)

```text
run(command="system_profiler SPFontsDataType")        # auto-truncated to 64 KiB
run(command="system_profiler SPFontsDataType", tail=false)  # full output
```

### Package management

```text
run(command="npm install")
run(command="pip install -r requirements.txt")
```

### Long-running processes (background)

```text
run(command="npm run dev", background=true)
run(command="python -m http.server 8080", background=true)
```

---

## Workflow patterns

### Background job (fire-and-poll)

```text
run(command="...", background=true)       → job_id + chain structure
jobs()                                     → overview list
status(id="J42")                          → state + stdout + stderr
log(id="J42")                             → history/log text
wait(id="J42", timeout=120)               → block until done
kill(id="J42")                            → stop if needed
```

For chain tasks, each leaf job gets its own ID (e.g., J42, J43, J44).
Check them individually with `status`. Use `jobs()` when you need
a broader overview first.

### Scope / env inspection

```text
scopes()
log()
log(id="J42")
```

### Changing working directory

The extension automatically passes cwd. To run in a different directory:

```text
run(command="ls", cwd="/path/to/target")
```

### Cron scheduling

```text
cron(action="add", schedule="every 5m", command="cargo test")
cron(action="add", schedule="in 30s", command="echo done")
cron(action="add", schedule="at 09:00 on weekdays", command="cargo build --release")
cron(action="add", schedule="*/5 * * * *", command="curl api/health")
cron(action="list")
status(id="C1")
cron(action="pause", id="C1")
cron(action="resume", id="C1")
cron(action="remove", id="C1")            # or: kill(id="C1")
```

**Important:** before creating a recurring cron, first test the same command
with a one-shot delayed schedule such as `in 30s` or `in 1m` to verify that
it really runs successfully in cue-shell.

---

## Interactive & multi-step tasks — use the cue TUI

cue-shell provides a full TUI (`cue`) for interactive work — job browsing,
scrolling output, foreground PTY, scopes, and more. **For multi-step
interactive tasks, guide the user to the cue TUI instead of trying to
simulate interaction through run.**

| Task type                      | Use                                     | Why                                         |
| ------------------------------ | --------------------------------------- | ------------------------------------------- |
| One-shot commands              | `run`                                   | Fire and forget                             |
| Reviewing job inventory        | `jobs` / `status`                       | Quick programmatic overview                 |
| Reviewing cron inventory       | `cron(action="list")` / `status`        | Quick programmatic overview                 |
| Reading state + output         | `status`                                | Single call returns all                     |
| Reading history                | `log`                                   | Text snapshot for one target or all history |
| Managing crons                 | `cron`                                  | Unified create/list/pause/resume/remove     |
| Managing environment scopes    | Tell user: `cue` → `:scope list --tree` | Visual scope tree                           |
| Foreground interactive process | Tell user: `cue` → `:run vim` → `:fg`   | PTY interaction                             |

---

## Common anti-patterns (shell habits that don't work in cue-shell)

cue-shell is NOT bash-compatible. These shell-isms will fail silently
or error out:

| ❌ Don't                           | ✅ Do instead                                 | Why                                                     |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------- | --- | -------------------------------------- |
| `ls *.pdf` / `rm *.tmp`            | `find . -name '*.pdf'`                        | cue-shell does no glob expansion                        |
| `cmd 2>/dev/null`                  | `cmd ~> echo ok` or check stderr via `status` | No shell redirect syntax; stderr is buffered per-job    |
| `cmd1 && cmd2`                     | `cmd1 -> cmd2`                                | `&&` is bash; use `->` for serial-on-success            |
| `echo $(date)`                     | Not supported                                 | No command substitution (`$()` / backtick)              |
| heredoc: `cat << EOF ... EOF`      | `write /tmp/x; run cat /tmp/x`                | heredoc syntax not available                            |
| `python3 -c "...nested quotes..."` | `write /tmp/s.py; run python3 /tmp/s.py`      | Quote nesting in `-c` is fragile; use a temp file       |
| `cd /some/path` inside `command`   | `run(command="ls", cwd="/some/path")`         | Scope changes belong in `cwd` parameter or chain syntax |
| `cmd1                              | cmd2`                                         | `cmd1 \|> cmd2`                                         | `   | `is reserved; use`\|>` for stdout pipe |

When in doubt: cue-shell is direct-exec with its own grammar. If you
catch yourself writing bash-isms, check the operator table above first.

**⚠️ Multiple sync `run()` calls in the same function_call block may be
merged by the agent framework into a single job.** If you need true
parallelism, use the `||` operator inside a single command string:
`run(command="cmd1 || cmd2 || cmd3")` or start background jobs
(`run(background=true)`).

## Failed jobs and stderr

Synchronous `run` will automatically include the last ~500 bytes of
stderr in the error message when a job fails. `status` always fetches
both stdout and stderr. This avoids extra round-trips for common debugging.

## Interaction with subagents, forks, and worktrees

When cue-shell is used inside `subagent(...)` with `context: "fork"` or
`worktree: true`:

- Each subagent / worktree task gets its **own isolated scope and cwd**
  inside the worktree directory.
- `scopes()` reflects that isolated environment, not the parent's.
- Background jobs started in a subagent do NOT carry over to the parent
  session. Check `jobs()` before assuming a job is still alive
  after a subagent returns.
- The `cwd` parameter to `run` always resolves relative to the
  worktree root (when active), not the original repo root.

When writing `chain` or `parallel` steps, pass explicit `cwd` if the
step needs to operate in a specific directory inside the worktree.

## Daemon check

The extension auto-starts `cued` on first use. If the daemon becomes
unreachable during a session, the extension will attempt to restart it
automatically.

Manual control is still available:

```text
cued start
cued stop
cued status
```

---

## Output limits

- Max buffered output per stream: 4 MiB
- Default timeout: 300 seconds (5 min)
- File-system commands (mv, cp, rm, ls, cat, find, ...): 10 seconds
- **`run`**: stdout/stderr truncated to last 64 KiB by
  default. Set `tail=false` for full output.
- **`status`**: defaults to last 64 KiB. Pass `tail_bytes=0` for full output.

---

## Troubleshooting

### Daemon not reachable

The extension auto-starts the daemon on first use and retries on connection
failure. If you see persistent "DAEMON_UNREACHABLE" errors:

```text
cued status  # check if cued is installed and in PATH
cued start   # manual start if auto-start fails
```

### "cd inside :run" errors

This means you used `cd` inside a `:run` command with extra arguments.
To change directory for a command, use the `cwd` parameter:

```text
run(command="ls", cwd="/some/path")
```

Or use chain syntax to combine `cd` with other scope transforms:

```text
run(command="cd /some/path -> cargo build")
```

### Stale cron entries

Crons can be removed with `kill(id="C<n>")` or `cron(action="remove", id="C<n>")`.
If you only want to stop triggering temporarily, prefer
`cron(action="pause", id="C<n>")` and later `cron(action="resume", id="C<n>")`.
