# spark-workflows

Spark-owned workflow metadata, journal, primitive, built-in script helpers, goal continuation, and ready-frontier workflow-run orchestration for `/workflow` strategy wiring.

This package vendors and rewrites selected MIT-licensed ideas from `@quintinshaw/pi-dynamic-workflows` and `pi-codex-goal`. It intentionally does not expose upstream TUI/editor/live-panel/slash-command registration or raw Pi subagent spawning.

Responsibilities:

- parse and run Spark workflow scripts and built-in workflow templates
- provide the Spark workflow role-run adapter boundary
- render and validate Spark goal continuation state for `/workflow:goal`
- persist workflow-run invocation records in `.spark/workflow-runs.json` via `SparkDagRunStore`
- schedule execution-ready tasks from `TaskGraph.readyTasks()` in concurrency-limited waves for `/workflow:ready`
- reconcile and summarize workflow-run state for Spark status/background tools

Non-responsibilities:

- does not own task/project graph state or plan readiness (`spark-tasks`)
- does not execute a single role-run or own active child process tracking (`spark-runtime`)
- does not register Pi tools or own UI/widget rendering (`spark` extension facade)
