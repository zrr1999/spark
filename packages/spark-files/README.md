# @zendev-lab/spark-files

Working-tree file tools for Spark extension hosts: `read`, `write`, `edit`, `ls`,
`grep`, and `find`. These give a Pi host the same coding-agent file surface as
pi-coding-agent, but the implementation depends only on
`@zendev-lab/spark-extension-api`, `typebox`, `diff`, `ignore`, and `minimatch` —
no `@earendil-works/pi-coding-agent` runtime, no `@earendil-works/pi-tui`, and
no `rg`/`fd`/`bash` subprocess.

## Tools

- `read` — read a text file with 1-indexed `offset`/`limit`. Output is
  truncated to 2000 lines or 50KB (whichever is hit first) with an actionable
  continuation notice (`Use offset=… to continue`). It has one output format:
  the raw-byte SHA-256 version followed by stable `LINE#HASH:text` anchors.
  Structured details carry the same version and window metadata. LF, CRLF,
  CR-only, mixed endings, and a UTF-8 BOM are reported as metadata while the
  visible anchors use logical line text. Invalid UTF-8 fails explicitly.
  Pagination values must be positive integers.
- `write` — atomically create or overwrite a file through a same-directory
  temporary file, preserving an existing file's mode. `expectedVersion` is
  required: pass the version returned by `read` to replace that exact snapshot,
  or `missing` for create-only intent. Missing, malformed, and stale
  preconditions fail without replacing the target. Writes are serialized by
  canonical target path inside the Spark process, including symlinked parent
  aliases, so concurrent Spark writes using the same version have one winner.
  A direct symbolic-link target is rejected instead of silently replacing the
  link.
- `edit` — exact-then-fuzzy multi-edit replacement. Each `edits[].oldText`
  matches the original content; overlapping, duplicate, empty, and
  no-op edits are rejected with precise errors. Its read/commit window uses the
  same atomic version check, so an intervening change fails instead of being
  overwritten. Emits a display diff plus a unified patch in `details`.
- `ls` — alphabetical directory listing with a `/` suffix for directories,
  capped at 500 entries / 50KB.
- `grep` — pure-JS content search returning `path:line: text`, with regex or
  literal matching, optional case-insensitivity, optional context lines, glob
  filtering, and match/byte/line truncation. Respects `.gitignore` plus hard
  `node_modules` / `.git` ignores.
- `find` — pure-JS glob file search over a gitignore-aware walk.

`bash` is intentionally omitted: Spark uses `cue_exec` for shell execution and
spark-cue disables bash by policy.

## Usage

```ts
import piFilesExtension, { registerPiFilesTools } from "@zendev-lab/spark-files";

// As a default extension factory:
piFilesExtension(pi);

// Or register a subset:
registerPiFilesTools(pi, { tools: ["read", "grep", "find"] });
```

Tools resolve their working directory from the extension context (`ctx.cwd`)
per call, so a single registration works across sessions with different cwds.

The sole read/write protocol is versioned: there is no plain read mode and no
blind write path. The check is content-level optimistic concurrency plus a
process-local per-path lock, not a cross-process filesystem transaction or a
Graft scratch graph. A non-cooperating external writer can still race the final
check. Atomic replacement creates a new inode: if the old file has sibling hard
links, those other names continue to reference the old inode and content. Graft
daemon, candidate, patch, and promotion semantics remain owned by the
separately opt-in `@zendev-lab/spark-graft` package.
