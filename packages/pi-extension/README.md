# @zendev-lab/pi-extension

Pi-compatible Spark command and policy facade. It registers lightweight default behavior plus `/plan`, `/implement`, `/goal`, `/loop`, `/workflow`, Spark widgets, and canonical owner-package tools.

The facade does not own task, artifact, workflow, role, session, or execution stores. It composes those package APIs through the host-neutral extension contract and must not import Spark app runtimes.

Public task execution uses `task_read`, `task_write`, and `assign`. Anonymous role calls use `role`; persistent continuity and mail use `session`. Patch/candidate work uses explicit Graft tools.
