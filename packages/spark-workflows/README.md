# spark-workflows

Generic saved-script workflow capability for Spark capability hosts.

`@zendev-lab/spark-workflows` discovers and previews saved scripts from controlled roots and owns host-neutral workflow runtime primitives. Prefer passing explicit workspace/user workflow directories from the host package; the exported workspace default reads `.spark/workflows/*.js`, and the user default reads `~/.agents/workflows/*.js`. It does not accept inline workflows and does not make goal state a workflow.
