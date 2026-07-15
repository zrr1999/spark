# spark-modes

Host-neutral operating-lens primitives for Spark-style agents.

## Purpose

`@zendev-lab/spark-modes` owns the per-turn **mode** vocabulary and rendering mechanics:

- `plan` and `implement` built-in lenses. Investigation and research are activities within `plan`, not separate lenses.
- `interactive`, `goal`, and `workflow` turn drivers.
- Open mode registry for host-defined custom lenses.
- Pure `mode` action-tool descriptor and action evaluation helpers.
- System-prompt marker and requirements assembly helpers.

The package is mechanism only. It does not persist mode state and does not import Spark extension, spark-cli, goal, workflow, task, or role runtime code.

## Boundary

Hosts decide which driver is active and which mode is suggested for a turn, then call this package to resolve and render the active lens. Durable state stays with the owning host package, such as goal state or workflow run state.
