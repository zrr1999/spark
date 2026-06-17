---
name: pi-cue
description: |
   Use cue-shell as the only execution backend (bash is disabled).
   cue-shell uses direct-exec with its own composition operators:
   |> pipes stdout inside one job, &&/|| are job-internal logical operators,
   -> and ~> run jobs serially, and |||/|?| compose jobs in parallel/race chains.
   Use cue_exec for direct commands; pass resource requirements with cue_exec needs={...}, not embedded :run(need...). Use cue_run for .cue files, cue_script for inline .cue scripts, and script_run/script_eval for explicit-language generic scripts.
   cue_jobs to list/status/wait/stop, cue_resources to inspect providers/resources, cue_schedule for scheduled tasks.
   cue-shell has its own grammar — not bash-compatible.
---

# pi-cue

**The bash tool is disabled. cue-shell is the only command execution tool.**

Use `cue_exec` for ALL commands — quick filesystem operations (ls, cat, grep),
builds, test suites, dev servers, and long-running background processes.
The extension uses the active cue-shell client transport profile. Local Unix
profiles connect to the daemon socket; SSH profiles connect through the
configured `ssh <destination> <gateway_command>` stdio gateway and do not
auto-start remote daemons. The extension automatically passes the current
working directory (cwd) to each command via `:run(cwd=...)` mode param; with
SSH profiles, that cwd must be valid on the remote host.

## Tool reference (10 resource-oriented tools)

| Category      | Tool            | Purpose                                     | Key parameters                                                                          |
| ------------- | --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Exec**      | `cue_exec`      | Execute a direct command and create a job   | `command`, `background?`, `timeout?`, `cwd?`, `pty?`, `needs?`, `tail_bytes?`           |
| **Script**    | `cue_run`       | Run a `.cue` file (`cue run <file.cue>`)    | `path`, `timeout?`, `tail_bytes?`                                                       |
| **Script**    | `cue_script`    | Run an inline `.cue` script body            | `script`, `pathLabel?`, `timeout?`, `tail_bytes?`                                       |
| **Script**    | `script_run`    | Run a script file with explicit language    | `path`, `language`, `timeout?`, `tail_bytes?`, `venv?`                                  |
| **Script**    | `script_eval`   | Run an inline script with explicit language | `script`, `language`, `pathLabel?`, `timeout?`, `tail_bytes?`, `venv?`                  |
| **Jobs**      | `cue_jobs`      | List/status/wait/stop jobs                  | `action` (list/status/wait/stop), `id?`, `status?`, `limit?`, `timeout?`, `tail_bytes?` |
| **Resources** | `cue_resources` | Inspect providers and resource snapshots    | `action?` (providers/resources)                                                         |
| **Schedule**  | `cue_schedule`  | Add/list/pause/resume/remove scheduled jobs | `action` (add/list/pause/resume/remove), `schedule?`, `command?`, `id?`, `limit?`       |
| **Scope**     | `cue_scope`     | Inspect scopes, env, or config              | `action` (list/env/config), `limit?`, `includeEnv?`, `tail_bytes?`                      |
| **History**   | `cue_history`   | Show recent history for a job/cron or all   | `id?`, `limit?`, `tail_bytes?`                                                          |

Tool names are resource-oriented: `cue_exec` is for direct commands, `cue_run` is for real `.cue` files, `cue_script` is for inline `.cue` script bodies, and `script_run`/`script_eval` are generic explicit-language script runners. Compact managers cover jobs, schedules, scopes, and history.

For `script_run` and `script_eval`, `venv` is valid only with `language="python"` and selects `<venv>/bin/python`. `script_eval` previews a fixed, bounded leading snippet of inline code in the rendered tool call without exposing display-only parameters in the callable schema.

`cue_exec` runs without a PTY by default (`pty=false`) so non-interactive commands get separate stdout/stderr and do not trigger terminal capability probes. Use `pty=true` only when a command genuinely needs terminal semantics; for sustained interactive work, use the cue TUI and `:fg` instead.

For resource-gated jobs, pass `needs` as an object whose keys omit the `need.` prefix. Examples: `needs={ gpu: 1, gpu_mem: "24GiB" }` or `needs={ license: 1 }`. **Do not** put `:run(need.gpu=1)` inside `command`; `pi-cue` already wraps `command` in `:run(...)` and encodes `needs` as mode params.

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

**Job logical operators** (inside one job):

| Operator | Effect                                      |
| -------- | ------------------------------------------- |
| `&&`     | Run right side only if left side succeeds   |
| `\|\|`   | Run right side only if left side fails      |

**Chain operators** (between jobs — each step is tracked individually):

| Operator | Effect                                      |
| -------- | ------------------------------------------- |
| `->`     | Run next job only if previous succeeds      |
| `~>`     | Run next job regardless of previous exit    |
| `\|\|\|` | Run both jobs concurrently                  |
| `\|?\|`  | Run jobs concurrently, stop after success   |

### Precedence and grouping

```text
pipe (|>)  >  job logical (&&/||)  >  chain parallel (|||/|?|)  >  serial (->/~>)

a |> b -> c ||| d    =    (a |> b) -> (c ||| d)
```

Group with `()` for explicit precedence:

```text
cue_exec(command="(cargo build ||| cargo audit) -> cargo test")
```

**⚠️ `cue_exec(command="...")` still sends `:run ...` to cue-shell.** Parentheses immediately after
`:run` are parsed as mode parameters. The adapter inserts the needed space before grouped commands.

```text
✅  cue_exec(command="(sleep 0.5 ||| echo fast) -> echo done")
```

### Converting from shell syntax

| Shell                      | cue-shell        |
| -------------------------- | ---------------- |
| `cmd1 && cmd2`             | `cmd1 && cmd2` inside one job, or `cmd1 -> cmd2` for tracked jobs |
| `cmd1 \|\| cmd2`           | `cmd1 \|\| cmd2` inside one job, or `cmd1 ~> cmd2` to ignore left failure before a tracked next job |
| `cmd1 & cmd2` (background) | `cmd1 \|\|\| cmd2` |
| `cmd1 \| cmd2`             | `cmd1 \|> cmd2`  |
| `cmd1 2>&1 \| cmd2`        | `cmd1 \|&> cmd2` |

---

## Common command patterns

### Build and test

```text
cue_exec(command="cargo build |> grep -E 'error|warning'")
cue_exec(command="cargo build -> cargo test")
cue_exec(command="cargo clippy ||| cargo test")
cue_exec(command="(cargo build ||| cargo audit) -> cargo test")
```

### File operations

```text
cue_exec(command="ls -la docs/")
cue_exec(command="cat README.md")
cue_exec(command="find . -name '*.rs' |> head -20")
```

### Long output commands (auto-truncated)

```text
cue_exec(command="system_profiler SPFontsDataType")                    # auto-tailed to 16 KiB/stream
cue_exec(command="system_profiler SPFontsDataType", tail_bytes=0)       # full output
cue_exec(command="system_profiler SPFontsDataType", tail_bytes=4096)    # smaller tail
```

### Package management

```text
cue_exec(command="npm install")
cue_exec(command="pip install -r requirements.txt")
```

### Long-running processes (background)

```text
cue_exec(command="npm run dev", background=true)
cue_exec(command="python -m http.server 8080", background=true)
```

### Resource-gated commands

```text
cue_resources(action="providers")
cue_resources(action="resources")
cue_exec(command="python train.py", needs={ gpu: 1, gpu_mem: "24GiB" }, background=true)
cue_exec(command="run-licensed-tool", needs={ license: 1 })
cue_jobs(action="list")          # pending jobs show resource pending reasons
cue_jobs(action="status", id="J42")
```

---

## Workflow patterns

### Background job (fire-and-poll)

```text
cue_exec(command="...", background=true)   → job_id + chain structure
cue_jobs(action="list")                            → overview list
cue_jobs(action="status", id="J42")                      → state + stdout + stderr
cue_history(id="J42")                         → history/log text
cue_jobs(action="wait", id="J42", timeout=120)           → block until done
cue_jobs(action="stop", id="J42")                        → stop if needed
```

For chain tasks, each leaf job gets its own ID (e.g., J42, J43, J44).
`cue_jobs(action="status"/"wait", id="CH...")` prioritizes failed, running, or output-producing leaves and summarizes clean successful leaves.
Check individual leaf IDs when you need every successful no-output step. Use `cue_jobs(action="list")` when you need
a broader overview first.

### Scope / env inspection

```text
cue_scope(action="list")                         # compact scope list, no env dump
cue_scope(action="list", includeEnv=true)          # include HEAD env, tailed by default
cue_history()                                 # recent global history only
cue_history(id="J42")                         # recent target history
cue_history(id="J42", limit=0, tail_bytes=0)  # full target history
```

### Changing working directory

The extension automatically passes cwd. To run in a different directory:

```text
cue_exec(command="ls", cwd="/path/to/target")
```

Relative `cwd` values (for example `cwd="."` or `cwd="subdir"`) are resolved against the
current Pi session working directory before being sent to `cued`.

### Cron scheduling

```text
cue_schedule(action="add", schedule="every 5m", command="cargo test")
cue_schedule(action="add", schedule="in 30s", command="echo done")
cue_schedule(action="add", schedule="at 09:00 on weekdays", command="cargo build --release")
cue_schedule(action="add", schedule="*/5 * * * *", command="curl api/health")
cue_schedule(action="list")
cue_jobs(action="status", id="C1")
cue_schedule(action="pause", id="C1")
cue_schedule(action="resume", id="C1")
cue_schedule(action="remove", id="C1")        # or: cue_jobs(action="stop", id="C1")
```

**Important:** before creating a recurring cron, first test the same command
with a one-shot delayed schedule such as `in 30s` or `in 1m` to verify that
it really runs successfully in cue-shell.

---

## Interactive & multi-step tasks — use the cue TUI

cue-shell provides a full TUI (`cue`) for interactive work — job browsing,
scrolling output, foreground PTY, scopes, and more. **For multi-step
interactive tasks, guide the user to the cue TUI instead of trying to
simulate interaction through `cue_exec`.**

| Task type                      | Use                                                         | Why                                         |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------- |
| One-shot commands              | `cue_exec`                                                  | Fire and forget                             |
| Reviewing job inventory        | `cue_jobs` / `cue_jobs(action="status")`                    | Quick programmatic overview                 |
| Reviewing cron inventory       | `cue_schedule(action="list")` / `cue_jobs(action="status")` | Quick programmatic overview                 |
| Reading state + output         | `cue_jobs(action="status")`                                 | Single call returns all                     |
| Reading history                | `cue_history`                                               | Text snapshot for one target or all history |
| Managing crons                 | `cue_schedule`                                              | Unified create/list/pause/resume/remove     |
| Managing environment scopes    | Tell user: `cue` → `:scope list --tree`                     | Visual scope tree                           |
| Foreground interactive process | Tell user: `cue` → `:run vim` → `:fg`                       | PTY interaction                             |

---

## Common anti-patterns (shell habits that don't work in cue-shell)

cue-shell is NOT bash-compatible. These shell-isms will fail silently
or error out:

| ❌ Don't                           | ✅ Do instead                                                     | Why                                                     |
| ---------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| `ls *.pdf` / `rm *.tmp`            | `find . -name '*.pdf'`                                            | cue-shell does no glob expansion                        |
| `cmd 2>/dev/null`                  | `cmd ~> echo ok` or check stderr via `cue_jobs(action="status")`  | No shell redirect syntax; stderr is buffered per-job    |
| `cmd1 && cmd2`                     | Keep `cmd1 && cmd2` inside one job, or use `cmd1 -> cmd2` for tracked jobs | `&&` is valid cue-shell job logic; `->` is tracked serial-on-success |
| `echo $(date)`                     | Not supported                                                     | No command substitution (`$()` / backtick)              |
| heredoc: `cat << EOF ... EOF`      | Write a file first, then `cue_exec(command="cat /tmp/x")`         | heredoc syntax not available                            |
| `python3 -c "...nested quotes..."` | Write a temp script, then `cue_exec(command="python3 /tmp/s.py")` | Quote nesting in `-c` is fragile; use a temp file       |
| `cd /some/path` inside `command`   | `cue_exec(command="ls", cwd="/some/path")`                        | Scope changes belong in `cwd` parameter or chain syntax |
| `cmd1 \| cmd2`                     | `cmd1 \|> cmd2`                                                   | `                                                       | `is reserved; use`\|>` for stdout pipe |

When in doubt: cue-shell is direct-exec with its own grammar. If you
catch yourself writing bash-isms, check the operator table above first.

**⚠️ Multiple sync `cue_exec()` calls in the same function_call block may be
merged by the agent framework into a single job.** If you need true
parallelism, use the `|||` chain operator inside a single command string:
`cue_exec(command="cmd1 ||| cmd2 ||| cmd3")` or start background jobs
(`cue_exec(background=true)`).

## Failed jobs and stderr

Synchronous `cue_exec` will automatically include bounded stderr in the
error message when a job fails. `cue_jobs(action="status")` fetches both stdout and stderr.
This avoids extra round-trips for common debugging.

## Interaction with subagents, forks, and worktrees

When cue-shell is used inside `subagent(...)` with `context: "fork"` or
`worktree: true`:

- Each subagent / worktree task gets its **own isolated scope and cwd**
  inside the worktree directory.
- `cue_scope(action="list")` reflects that isolated environment, not the parent's.
- Background jobs started in a subagent do NOT carry over to the parent
  session. Check `cue_jobs(action="list")` before assuming a job is still alive
  after a subagent returns.
- The `cwd` parameter to `cue_exec` always resolves relative to the
  worktree root (when active), not the original repo root.

When writing `chain` or `parallel` steps, pass explicit `cwd` if the
step needs to operate in a specific directory inside the worktree.

## Daemon and transport check

The extension honors cue-shell client transport profiles resolved by
`cue-client target resolve --json` or `cue client target resolve --json`.
Unix profiles connect to the resolved socket; if the local daemon is
unreachable, the extension may auto-start `cued` for that Unix socket. SSH
profiles connect through the configured gateway command over stdio and do not
auto-start the remote daemon.

Manual local control is still available:

```text
cued start
cued stop
cued status
```

For SSH profiles, start the remote daemon explicitly, for example:

```text
ssh user@example.com "cued start"
```

---

## Output limits

- Max buffered output per stream: 4 MiB
- Default timeout: 300 seconds (5 min)
- File-system commands (mv, cp, rm, ls, cat, find, ...): 10 seconds
- **`cue_exec`**: runs with `pty=false` by default; stdout/stderr are tailed to 16 KiB per stream by default. Pass `tail_bytes=0` for full output.
- **Cue-shell scripts** (`cue_run`, `cue_script`, `script_run language=cue-shell`, `script_eval language=cue-shell`): successful no-output items are summarized; failed/message/output-producing items remain expanded.
- **`cue_jobs(action="status")` / `cue_jobs(action="wait")`**: default to 16 KiB per stream. Chain output summarizes clean successful leaves and prioritizes failed/running/non-clean leaves. Pass `tail_bytes=0` for full output.
- **`cue_history`**: passes `limit` and `tail_bytes` to the daemon when supported, then applies client-side safety trimming.

---

## Troubleshooting

### Daemon not reachable

For Unix profiles, the extension auto-starts the daemon on first use and
retries on connection failure. If you see persistent "DAEMON_UNREACHABLE"
errors:

```text
cued status  # check if cued is installed and in PATH
cued start   # manual start if auto-start fails
```

For SSH profiles, the error refers to the remote gateway. Start or repair the
remote daemon explicitly, then retry the Pi tool call.

### "cd inside :run" errors

This means you used `cd` inside a `:run` command with extra arguments.
To change directory for a command, use the `cwd` parameter:

```text
cue_exec(command="ls", cwd="/some/path")
```

Or use chain syntax to combine `cd` with other scope transforms:

```text
cue_exec(command="cd /some/path -> cargo build")
```

### Stale cron entries

Crons can be removed with `cue_jobs(action="stop", id="C<n>")` or `cue_schedule(action="remove", id="C<n>")`.
If you only want to stop triggering temporarily, prefer
`cue_schedule(action="pause", id="C<n>")` and later `cue_schedule(action="resume", id="C<n>")`.
