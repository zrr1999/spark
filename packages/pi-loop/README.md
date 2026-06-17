# pi-loop

`@zendev-lab/pi-loop` provides generic loop lifecycle primitives for Pi extensions.

A loop is only a continuation substrate with an `active | paused` lifecycle; absence is represented by clearing/null loop state. It can continue, wait, pause, retry, or report blockers. It does **not** decide that a goal is complete, call reviewer gates, or own task/workflow success semantics.

Higher-level packages layer policy on top:

- `pi-goal`: loop + objective state + completion policy/reviewer gate.
- Spark `/loop`: loop continuation without automatic completion.
- Spark `/goal`: loop continuation plus goal completion judgment.
