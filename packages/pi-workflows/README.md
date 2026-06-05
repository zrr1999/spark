# pi-workflows

Generic saved-script workflow capability for Pi extensions.

`pi-workflows` only discovers and previews saved scripts from controlled roots: workspace `.spark/workflows/*.js` and user `~/.agents/workflows/*.js`. It does not accept inline workflows and does not make `/goal` a workflow.
