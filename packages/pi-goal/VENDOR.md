# Spark goal vendoring notes

## Upstream

- Source: https://github.com/fitchmultz/pi-codex-goal
- Revision: cc2ac14d6a1e2bdf6baa1ee635bda0e08452bdd8 (latest main fetched for M1)
- Upstream package version at revision: 0.1.21
- Upstream license: MIT
- Upstream copyright: Copyright (c) 2026 Mitch Fultz

## License notice

The vendored source is derived from MIT-licensed pi-codex-goal. Preserve this attribution when redistributing substantial portions of the code: Copyright (c) 2026 Mitch Fultz.

## Copied and renamed

- types.ts: goal data model, renamed ThreadGoal to Goal and custom entry type to pi-goal.
- state.ts: validation, reconstruction, and state transitions, renamed createThreadGoal to createGoal.
- format.ts: status formatting helpers with user-facing slash-command hints removed.
- prompts.ts: continuation/completion-audit prompts with Spark-owned tool names and spark_goal_continuation marker.

## Removed features

- Token budget and usage accounting (tokenBudget, usage, budgetLimited status, runtime usage entries). Spark goals track objective and lifecycle status only.

## Omitted upstream features

- Pi extension entrypoint and slash command registration.
- Model-callable get_goal, create_goal, and update_goal tool registration.
- Global/session storage controller and runtime event handlers.
- Recovery machine, stale queued work guard, platform smoke scripts, and prompt-template registration.
- Any automatic goal command wiring; Spark connects this package through its workflow goal backend.

## Local ownership

Goal continuation code lives under `packages/pi-goal` and is treated as Spark-owned goal code, separate from workflow script parsing and workflow-run scheduling. Future API names, file layout, and behavior should follow Spark project semantics.
