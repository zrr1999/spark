# spark-artifacts

Product artifacts (`issue` / `pr` / `preview`) for users, plus an **agent-internal evidence ledger** that is not shown in Cockpit.

## Two surfaces

| Surface | Tool | Kinds | User-visible? | On-disk |
|---|---|---|---|---|
| **Product artifacts** | `artifact` | `issue`, `pr`, `preview` | Yes (Cockpit `/artifacts`) | `.spark/artifacts/` |
| **Internal evidence** | `evidence` | `record` (default), `trace`, `knowledge`, `document` | No | `.spark/artifacts/` (compat); `defaultEvidenceStore` can use `.spark/evidence/` |

- ISSUE/PR sync from GitHub (`gh`) or GitLab (`glab`).
- PR create prefers a git worktree under `.spark/worktrees/pr-…`.
- Preview artifacts are continuously updated (version + progress).

### Evidence (agent-only)

Prefer compact JSON notes:

```json
{ "summary": "one-line fact", "data": { } }
```

Do not write long markdown essays into evidence. Use `artifact` for anything the user should see.

Import Generative UI from `@zendev-lab/spark-artifacts/generative-ui`.
Import product helpers from `@zendev-lab/spark-artifacts/product` or the package root.

- `defaultProductArtifactStore(cwd)` → `.spark/artifacts/` (product kinds only)
- `defaultEvidenceStore(cwd)` → `.spark/evidence/` (+ legacy `.spark/artifacts/` reads)
- `defaultArtifactStore(cwd)` / `evidence` tool → historical evidence root `.spark/artifacts/` (compat with ask/runtime)
