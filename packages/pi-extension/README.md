# @zendev-lab/pi-extension

Frozen Pi product loader facade over `@zendev-lab/spark-extension`.

Spark-native hosts (TUI, daemon headless) must use `@zendev-lab/spark-extension`
instead. This package remains loadable so Pi product discovery keeps working,
but it contains no Spark policy or durable state implementation.

Public task execution uses `task_read`, `task_write`, and `assign`. Anonymous role
calls use `role`; persistent continuity and mail use `session`. The separate
`@zendev-lab/spark-graft` package remains available for explicit opt-in
patch/candidate workflows but is not part of Spark's default extension profile.
