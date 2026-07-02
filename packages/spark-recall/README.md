# spark-recall

Controlled lightweight recall capability for Spark extension hosts.

`@zendev-lab/spark-recall` is not `.learnings/` and not automatic memory. It records explicit `user | workspace | repo` scoped recall candidates for review/search, and keeps them separate from task truth and evidence-backed learnings.

New hosts should inject explicit `RecallStore` paths or `registerPiRecallTool(..., { storePaths })` paths for user/workspace/repo scopes. `defaultRecallStore(cwd, scope)` writes `.spark/recall-candidates.json`.
