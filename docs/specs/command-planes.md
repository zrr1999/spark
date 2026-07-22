# Spark command planes

Canonical CLI grammar:

```text
spark <plane> <resource> <verb> [args...]
```

## Namespaces

| Namespace | Role | Owns | Does not own |
| --- | --- | --- | --- |
| `spark daemon` | daemon execution plane | persistent sessions, channel listeners, SQLite invocations, events, logs, process state | project/task/goal/review policy |
| `spark cockpit` | coordination plane and web UI host | project, task, goal, review, evidence, workflow, workspace coordination, assign, and Cockpit UI | daemon execution, local process logs, TUI rendering |
| `spark tui` | tui local control plane | interactive terminal UI, attach/resume, visible transcript, theme, export | canonical business-state ownership |
| slash `system` | TUI kernel command source | `/help`, `/exit`, `/quit`, `/clear`, `/reload` | project/task/goal/session/workflow commands |
| slash `extension` | extension command source | extension-owned resource commands | TUI kernel lifecycle |

`spark cockpit` is both the coordination CLI and the web UI host; it is not a second daemon execution plane.

## Boundary invariants

- Every stateful domain has exactly one authoritative owner. `packages/spark-cockpit-coordination` owns server coordination plus Cockpit query/projection APIs, but its projections are never execution truth for tasks, runs, artifacts, asks, reviews, or invocations.
- Transports and app adapters translate through owner APIs; they do not duplicate execution or policy, and they must not read or write another owner's store. Cockpit may cache or project Spark state, but it must not mutate local Spark stores directly.
- Reusable capability and runtime behavior belongs in `packages/spark-*`; executable apps retain bootstrap, presentation, and compatibility glue. Boundary regressions are enforced by `pnpm run check:boundaries`.

## Canonical examples

```bash
spark daemon session list --json
spark daemon session create --workspace <id> --json
spark daemon submit --session <session-id> --prompt <text> --json
spark daemon invocation list --status failed --since 24h --limit 50 --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation result <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
spark daemon invocation retry <invocation-id> --json
spark daemon invocation retention --before <iso-time> --limit 100 --json
spark daemon channel status --json
spark daemon events watch --json

spark cockpit status --json
spark cockpit task list --project <project-ref> --json
spark cockpit assign --session <session-id> --goal "..." --json

spark tui attach <session-id>
spark tui --help
```

Session identity and channel policy are specified in [`sessions-and-channels.md`](./sessions-and-channels.md).

## Invalid placements

These shapes are not canonical and must fail:

```bash
spark server status
spark daemon sessions list --all-workspaces
spark daemon task claim <task-ref>
spark daemon goal complete
spark cockpit invocation status <invocation-id>
spark cockpit events watch
spark cockpit session create
spark tui task list
spark gateway ...
```

State commands must provide stable `--json` output. Human-readable output is not an automation contract. CLI owns canonical placement; slash commands are interactive aliases. Zellij is an operator validation tool, never a runtime dependency.
