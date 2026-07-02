# @zendev-lab/spark-generative-ui

Safe Spark Generative UI schema and parser package.

This package owns the host-neutral `spark.ui.v1` AST and the safe MDX-like parser
used for agent-authored UI source. It does **not** execute MDX, JSX, imports,
exports, or JavaScript expressions. Cockpit and other renderers consume the JSON
AST through their own allowlisted component catalogs.

The intended artifact pattern is:

- source artifact: `kind=document`, `format=markdown`
- derived UI AST artifact: `kind=record`, `format=json`, linked back to the
  source with `derived-from`
