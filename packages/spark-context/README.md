# spark-context

Compatibility re-export package. Context provider tooling now lives in
`@zendev-lab/spark-host/context`.

Prefer:

```ts
import { registerSparkContextTool } from "@zendev-lab/spark-host/context";
```

This package remains only so existing publish/dependency graphs and Pi-facade
imports keep resolving until callers migrate.
