# @zendev-lab/pi-extension

Pi-compatible Spark command and policy facade. It registers lightweight default behavior plus `/plan`, `/implement`, `/goal`, `/loop`, `/workflow`, Spark widgets, and canonical owner-package tools.

The facade does not own task, artifact, workflow, role, session, or execution stores. It composes those package APIs through the host-neutral extension contract and must not import Spark app runtimes.

Public task execution uses `task_read`, `task_write`, and `assign`. Anonymous role calls use `role`; persistent continuity and mail use `session`. The separate `@zendev-lab/spark-graft` package remains available for explicit opt-in patch/candidate workflows but is not part of Spark's default extension profile.
