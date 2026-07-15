# @zendev-lab/spark-roles

Owns reusable `RoleSpec` definitions, role model settings, anonymous `RoleRun` execution, and the canonical `role` tool.

## Storage and models

Role Markdown loads from project `.agents/roles/**/*.md`, user `~/.agents/roles/**/*.md`, builtins, and loaded extensions. Role files do not carry `model` or `defaultModel`; Spark model bindings live separately in project `.spark/role-model-settings.json` and user `${SPARK_HOME:-$HOME/.spark}/role-model-settings.json`. Resolution order is explicit run model, project settings, then user settings.

## Public surface

- `list | get | create` manage definitions.
- `call` runs one fresh anonymous role invocation.
- `model_list | model_get | model_set | model_delete` manage model settings.

Persistent identity, lifecycle, bindings, continuity, calls, and mail belong to canonical `session`. `role` must not accept `resource=session`, session lifecycle, mail, or `sessionId`.

Builtin role capability profiles are `scout = read + net`, `reviewer = read + net`, and `worker = read + net + exec + write`. They do not receive interactive or orchestration tools and report blockers upward.

Managed task execution remains the task/workflow scheduler's responsibility; direct role calls do not claim tasks or create task evidence.
