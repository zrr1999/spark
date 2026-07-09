# Spark command planes

Spark's public control model is daemon-native and split by plane role rather than by Pi-compatible surface area.

The canonical command grammar is:

```text
spark <plane> <resource> <verb> [args...]
```

## Canonical namespaces

| Namespace | Role | Owns | Does not own |
| --- | --- | --- | --- |
| `spark daemon` | daemon execution plane | runtime sessions, local queue, runs, events, logs, process state | project/task/goal/review policy decisions |
| `spark server` | server coordination plane | project, task, goal, review, artifact/evidence, workflow, workspace coordination state | local queue workers, process logs, TUI rendering, Cockpit UI hosting |
| `spark cockpit` | Cockpit web UI host (not a fourth plane) | start/preview the SvelteKit Cockpit UI that mounts `spark-server` | coordination commands (`spark server ...`), daemon execution, TUI rendering |
| `spark tui` | tui local control plane | local interactive terminal UI, attach/resume/new visible transcript, theme/keymap/export/share | canonical business state mutations |
| slash `system` | TUI kernel command source | `/help`, `/exit`, `/quit`, `/clear`, `/reload` | project/task/goal/session/workflow business commands |
| slash `extension` | extension command source | `/goal`, `/task`, `/workflow`, `/session`, `/review`, `/artifact`, `/run` resource aliases | TUI kernel lifecycle |

`spark server` is the coordination plane, not a network service in this phase. `spark cockpit` only launches the Cockpit web UI host.

## Canonical examples

```bash
spark daemon session list --json
spark daemon session show <session-id> --json
spark daemon run list --json
spark daemon events watch --json

spark server status --json
spark server project list --json
spark server task list --project <project-ref> --json
spark server goal status --json

spark tui attach <session-id>
spark tui --help
```

## Disallowed canonical placements

These command shapes are not canonical and must either fail with actionable guidance or be compatibility aliases documented in the deprecation map:

```bash
spark daemon sessions list --all-workspaces
spark daemon task claim <task-ref>
spark daemon goal complete
spark server queue clear
spark server events watch
spark tui task list
```

## Slash command ownership

System slash commands are intentionally small. Business commands are extension-owned resource commands and should map to canonical CLI targets:

| Legacy slash | Canonical slash | Canonical CLI target | Status |
| --- | --- | --- | --- |
| `/tasks` | `/task list` | `spark server task list` | deprecated alias |
| `/sessions` | `/session list` | `spark daemon session list` | deprecated alias |
| `/workflow-runs` | `/workflow list` | `spark server workflow list` | deprecated alias |
| `/workflow-pause` | `/workflow pause <run>` | `spark server workflow pause <run>` | deprecated alias |
| `/workflow-resume` | `/workflow resume <run>` | `spark server workflow resume <run>` | deprecated alias |
| `/workflow-stop` | `/workflow stop <run>` | `spark server workflow stop <run>` | deprecated alias |
| `/fork` | `/session fork --current` | `spark daemon session fork --current` | deprecated alias |

## Output policy

- Commands that expose state must support `--json` with stable fields.
- Text output is for humans and must not be the only source of machine-readable state.
- CLI is canonical; slash commands are interactive aliases.
- Zellij may be used for operator validation and visible TUI capture, but Spark must not depend on zellij at runtime.
