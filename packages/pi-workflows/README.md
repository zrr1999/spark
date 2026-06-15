# pi-workflows

Generic saved-script workflow capability for Pi extensions.

`@zendev-lab/pi-workflows` only discovers and previews saved scripts from controlled roots. Prefer passing explicit workspace/user workflow directories from the host package; the exported workspace default still reads `.spark/workflows/*.js` for compatibility, and the user default reads `~/.agents/workflows/*.js`. It does not accept inline workflows and does not make goal state a workflow.
