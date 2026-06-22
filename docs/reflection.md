# Spark reflection MVP

Spark reflection is an opt-in Pi session-local helper for periodically organizing recent Pi session history and surfacing possible unfinished work.

## Commands

Use `/reflect` inside a Pi/Spark session:

- `/reflect run` or `/reflect once` — run one incremental reflection pass now.
- `/reflect start [--interval-ms N]` — start a session-local timer. Intervals below 30 seconds are clamped to 30 seconds.
- `/reflect status` — show whether the timer is running for the current workspace session.
- `/reflect stop` — stop the timer for the current workspace session.

Advanced test/debug options:

- `--session-root PATH` — override the Pi session JSONL root. Defaults to `~/.pi/agent/sessions`.
- `--max-candidates N`, `--max-observations N`, `--max-themes N`, `--max-excerpt-chars N` — bound synthesis/report size.

## What a run writes

A reflection run writes only report-owned reflection files under the current workspace:

- `.spark/reflections/session-scan-cursor.json` — incremental cursor; already-scanned lines are skipped later.
- `.spark/reflections/candidates.json` — report-only candidate inbox; candidates can be ignored/resolved/exported without becoming Spark tasks.
- `.spark/reflections/latest-report.md` — deterministic synthesis report.

The MVP intentionally does **not** call Spark task/project mutation APIs and does not auto-create tasks from historical prompts.

## Session-local limitation

The scheduler is not a daemon. It exists only inside the currently running Pi extension process/session:

- No background work starts from the extension factory.
- `/reflect start` creates an in-memory timer keyed by the current workspace cwd.
- Timers are cleared on session lifecycle events such as shutdown, reload, new, resume, fork, and quit.
- Only one timer and one active reflection run are allowed for a workspace; overlapping runs are skipped.

This keeps behavior auditable and avoids hidden long-lived background work.

## Privacy, deletion, and disabling

The MVP scans local Pi JSONL session files and writes local `.spark/reflections/*` files in the current workspace. It does not upload excerpts, call web/LLM APIs, or write long-term memory automatically.

To disable periodic reflection, run `/reflect stop` or exit/reload the Pi session. To delete reflection outputs, remove `.spark/reflections/` from the workspace. Deleting the cursor causes the next `/reflect run` to rescan historical session lines.

## Related systems and rationale

The design intentionally borrows the useful parts of related systems while avoiding their higher-risk background or memory semantics in the MVP:

- **Pi session format** (`@earendil-works/pi-coding-agent/docs/session-format.md` in the installed Pi package): gives the JSONL source of truth used by the scanner. The MVP reads this durable log instead of screen/OCR capture.
- **pi-memory** (`~/.pi/agent/npm/node_modules/pi-memory/README.md`): demonstrates local memory/search patterns, but this MVP does not auto-write memories; candidates remain a reviewable report-only inbox.
- **Claude Code memory** (<https://docs.anthropic.com/en/docs/claude-code/memory>): uses explicit project/user memory files. This MVP similarly favors explicit local files, but keeps reflection output separate from durable instruction memory.
- **Ambient/background coding modes** such as jcode Ambient Mode and Codex/Chronicle-style reflection systems: motivate periodic organization, but the MVP avoids hidden daemons and automatic task mutation until a separate opt-in daemon boundary exists.
- **Hermes/Hindsight-style post-hoc summarization**: motivates low-authority summaries, but historical prompts and summaries are quoted as untrusted evidence rather than instructions.

Out-of-scope for this MVP: screen capture, OCR, browser/web ingestion, external vector memory writes, autonomous task creation, and autonomous project mutation.

## Future daemon boundary

A future daemon should be a separate explicitly-started component with its own lock file, durable run state, opt-in configuration, and observable status. It should reuse the same scanner/candidate/synthesis modules, but daemon lifecycle, scheduling policy, concurrency, privacy controls, and user consent should live outside the Pi session-local extension.

Until that boundary exists, `/reflect start` is only a convenience timer for the active Pi session.
