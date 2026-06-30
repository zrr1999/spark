# @zendev-lab/spark-i18n

Shared Spark localization helpers and Inlang/Paraglide message boundary.

This package owns Spark locale types, language matching, formatting helpers, and generated Paraglide message functions. App-specific policy such as Cockpit cookie names and localized routing remains in the app layer.

Generate Paraglide output before checking or consuming generated exports:

```sh
pnpm --filter @zendev-lab/spark-i18n generate
```
