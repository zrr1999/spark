# spark-workflows

Generic saved-script workflow capability for Spark capability hosts.

`@zendev-lab/spark-workflows` discovers and previews saved scripts from controlled roots and owns host-neutral workflow runtime primitives. Project workflows use `.agents/workflows/*.js`, and user workflows use `$HOME/.agents/workflows/*.js`; explicit directory overrides remain available to embedded hosts and tests. It does not accept inline workflows and does not make goal state a workflow.
