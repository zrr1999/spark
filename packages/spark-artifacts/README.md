# spark-artifacts

Reusable artifact/evidence storage for Spark capability hosts.

`@zendev-lab/spark-artifacts` owns content-addressed artifact metadata, blobs, provenance, links, the canonical `artifact` tool, and the safe `spark.ui.v1` Generative UI parser used by Cockpit artifact rendering.

Import Generative UI types and parsing from `@zendev-lab/spark-artifacts/generative-ui`.

Prefer constructing `ArtifactStore` with an explicit `rootDir` owned by the host package. The exported `defaultArtifactStore(cwd)` reads `.spark/artifacts/`.

## Curation lifecycle

Artifacts are cheap to record but expensive to keep in the default working set. New writes receive curation metadata so callers can separate noisy evidence from durable essence:

- `raw` — high-volume evidence/traces/review records; hidden by the `artifact` tool's default list.
- `candidate` — possible essence that may be promoted after synthesis.
- `curated` — durable signal worth keeping visible by default.
- `archived` / `superseded` — retained for provenance but hidden unless requested.

Retention hints (`ephemeral`, `task`, `project`, `durable`) describe how long an artifact should matter. Use `artifact({ action: "promote" | "archive" | "supersede", ... })` to keep the artifact set focused without deleting provenance.
