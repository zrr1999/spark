# @zendev-lab/pi-files

Working-tree file tools for Pi sessions: `read`, `write`, `edit`, `ls`,
`grep`, and `find`. These give a Pi host the same coding-agent file surface as
pi-coding-agent, but the implementation depends only on
`@zendev-lab/pi-extension-api`, `typebox`, `diff`, `ignore`, and `minimatch` —
no `@earendil-works/pi-coding-agent` runtime, no `@earendil-works/pi-tui`, and
no `rg`/`fd`/`bash` subprocess.

## Tools

- `read` — read a text file with 1-indexed `offset`/`limit`. Output is
  truncated to 2000 lines or 50KB (whichever is hit first) with an actionable
  continuation notice (`Use offset=… to continue`).
- `write` — create or overwrite a file, creating parent directories.
- `edit` — exact-then-fuzzy multi-edit replacement. Each `edits[].oldText`
  matches the original content; overlapping, duplicate, empty, and
  no-op edits are rejected with precise errors. Emits a display diff plus a
  unified patch in `details`.
- `ls` — alphabetical directory listing with a `/` suffix for directories,
  capped at 500 entries / 50KB.
- `grep` — pure-JS content search returning `path:line: text`, with regex or
  literal matching, optional case-insensitivity, optional context lines, glob
  filtering, and match/byte/line truncation. Respects `.gitignore` plus hard
  `node_modules` / `.git` ignores.
- `find` — pure-JS glob file search over a gitignore-aware walk.

`bash` is intentionally omitted: Spark uses `cue_exec` for shell execution and
pi-cue disables bash by policy.

## Usage

```ts
import piFilesExtension, { registerPiFilesTools } from "@zendev-lab/pi-files";

// As a default extension factory:
piFilesExtension(pi);

// Or register a subset:
registerPiFilesTools(pi, { tools: ["read", "grep", "find"] });
```

Tools resolve their working directory from the extension context (`ctx.cwd`)
per call, so a single registration works across sessions with different cwds.
