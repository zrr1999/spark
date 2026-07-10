# Spark capabilities and artifact-backed Generative UI

Status: selected concept for implementation
Date: 2026-07-01

## Summary

Spark capability packages are moving from the old `pi-*` naming vocabulary to
Spark-owned `spark-*` package names. The package rename is a product naming and
ownership change, not a user-facing tool rename. Canonical tools such as
`artifact`, `ask`, `task_read`, `task_write`, `assign`, `cue_exec`, and
`graft_*` remain stable.

The same boundary gives Spark Cockpit a safe Generative UI path: agents may emit
Markdown/MDX-like source while running, Spark parses that source into a
non-executable `spark.ui.v1` JSON AST, and Cockpit renders the AST through an
allowlisted component catalog. Completed UI output is stored as linked artifacts
so it can be audited, replayed, and cached without executing agent-authored
JavaScript.

`pi-btw` is explicitly out of scope for this rename. It remains a Pi-specific
side-conversation workflow until a separate decision redesigns it as a
Spark-native capability.

## Goals

- Rename Spark-owned capability packages to `@zendev-lab/spark-*` over staged
  implementation waves.
- Keep public/default tool names and command semantics stable during the package
  rename.
- Keep Generative UI parsing in `@zendev-lab/spark-artifacts/generative-ui` for a safe
  Markdown/MDX-like agent output grammar and `spark.ui.v1` schema.
- Store generated UI as provenance-backed artifacts: source plus derived JSON
  AST linked by `derived-from`.
- Clarify Spark Cockpit navigation around work, library, runtime, and system
  areas before adding more artifact/UI surfaces.

## Non-goals

- Do not rename, redesign, or migrate `pi-btw` in this workstream.
- Do not execute arbitrary MDX, JSX, imports, exports, or JavaScript expressions
  from agent output in the Cockpit DOM.
- Do not rename canonical public tools or slash commands as part of package
  renaming.
- Do not fold artifact storage, parser/schema logic, and Svelte rendering into
  one package. Storage, schema/parser, and UI rendering stay separate.
- Do not add empty placeholder Cockpit routes solely for future concepts.

## Package naming contract

Current package names remain valid until the staged rename tasks land. The target
canonical names are:

| Current package | Target package | Notes |
| --- | --- | --- |
| `@zendev-lab/spark-extension-api` | *(current)* | Host/tool contract and shared refs/helpers. |
| `@zendev-lab/pi-artifacts` | `@zendev-lab/spark-artifacts` | Artifact metadata, blobs, provenance, links, and `artifact` tool. |
| `@zendev-lab/spark-ask` | `@zendev-lab/spark-ask` | Structured ask/flow capability and canonical `ask` tool. |
| `@zendev-lab/spark-context` | `@zendev-lab/spark-context` | Registered context provider listing/preview capability. |
| `@zendev-lab/spark-cue` | `@zendev-lab/spark-cue` | cue-shell execution adapter and `cue_*` tools. |
| `@zendev-lab/spark-files` | `@zendev-lab/spark-files` | Working-tree file tools. Tool names stay `read`, `write`, `edit`, `grep`, `find`, `ls`. |
| `@zendev-lab/spark-graft` | `@zendev-lab/spark-graft` | Graft scratch/candidate/patch workflow tools. |
| `@zendev-lab/spark-learnings` | `@zendev-lab/spark-learnings` | Evidence-backed learning records and `learning` tool. |
| `@zendev-lab/pi-loop` | `@zendev-lab/spark-loop` | Loop and goal lifecycle primitives used by Spark foreground flows. |
| `@zendev-lab/pi-modes` | `@zendev-lab/spark-modes` | Per-turn phase/mode registry and renderers. |
| `@zendev-lab/spark-recall` | `@zendev-lab/spark-recall` | Controlled scoped recall candidate capability. |
| `@zendev-lab/spark-roles` | `@zendev-lab/spark-roles` | Role specs, model settings, and role-run helpers. |
| `@zendev-lab/pi-tasks` | `@zendev-lab/spark-tasks` | Project/task/TODO/run graph and `task_read`/`task_write`/`assign`. |
| `@zendev-lab/pi-workflows` | `@zendev-lab/spark-workflows` | Saved workflow discovery and workflow-run state. |
| `@zendev-lab/pi-btw` | unchanged | Out of scope; remains Pi-specific for now. |

### Stable public surfaces

The rename changes package import specifiers and directory names, not the
agent-facing tool vocabulary. These public surfaces remain stable unless a
separate product decision changes them:

- `artifact(...)`
- `ask(...)`
- `context(...)`
- `cue_exec(...)`, `cue_run(...)`, `cue_jobs(...)`, and related `cue_*` tools
- `read(...)`, `write(...)`, `edit(...)`, `grep(...)`, `find(...)`, `ls(...)`
- `graft_*` tools
- `learning(...)`
- `loop(...)`, `goal(...)`, `drive(...)`, `phase(...)`
- `recall(...)`
- `role(...)`
- `task_read(...)`, `task_write(...)`, `assign(...)`
- `workflow(...)`, `workflow_run(...)`

Temporary compatibility shims are allowed only when needed for active external
consumers or publish safety. Prefer direct rolling updates inside this monorepo.

## Artifact-backed Generative UI

### Runtime model

```text
agent assistant stream
  -> Markdown/MDX-like source buffer
  -> spark-artifacts/generative-ui parser
  -> spark.ui.v1 JSON AST + diagnostics
  -> Cockpit Svelte renderer using an allowlisted component catalog
  -> source artifact + derived AST artifact at stable turn/run boundaries
```

The live renderer may update while the assistant is streaming, but artifact
writes happen at stable boundaries such as turn completion or explicit generated
UI records. Spark should not write one artifact per token.

### Artifact convention

Generated UI is represented by at least two artifacts:

| Artifact | Kind | Format | Purpose |
| --- | --- | --- | --- |
| Source | `document` | `markdown` | Original agent-authored Markdown/MDX-like source for audit and raw fallback. |
| UI AST | `record` | `json` | Parsed `spark.ui.v1` JSON AST suitable for replay and Cockpit rendering. |

The UI AST artifact links back to the source artifact with
`relation: "derived-from"`. Both artifacts carry strict provenance, normally
including the task/run refs for the agent turn that produced them.

A minimal AST body shape is:

```json
{
  "schemaVersion": 1,
  "sourceFormat": "mdx-lite",
  "blocks": [
    { "type": "markdown", "text": "## Validation result" },
    {
      "type": "component",
      "name": "ArtifactCard",
      "props": { "artifactRef": "artifact:example" }
    }
  ],
  "diagnostics": []
}
```

### Safe MDX-like grammar

The Generative UI parser in `spark-artifacts/generative-ui` supports Markdown plus a
small component-like syntax that parses into JSON. It must not compile or run
MDX as JavaScript.

Allowed by default:

- Markdown text blocks.
- Allowlisted components with JSON-serializable props.
- Spark references such as `artifactRef`, `taskRef`, `runRef`, and `projectRef`.
- Callout/status/card/timeline-style components registered by the Cockpit
  renderer.
- Recoverable diagnostics for incomplete streaming tags or invalid props.

Rejected or downgraded to visible source/placeholder output:

- `import` / `export` statements.
- JavaScript expressions such as `{someFunction()}`.
- Event-handler props such as `onclick` / `onerror`.
- Dangerous URLs such as `javascript:`.
- Raw `<script>` content.
- Unknown components unless the component catalog explicitly allows a fallback.

### Initial component families

The initial catalog should cover Spark concepts that map naturally to existing
state and artifacts:

- `ArtifactCard` / artifact inline links.
- `TaskStatus` / task summary blocks.
- `RunTimeline` / run summary blocks.
- `Callout` for informational, warning, success, and error notes.
- Plain Markdown sections for prose and code blocks.

The catalog is a rendering policy, not a storage policy. The AST remains
JSON-serializable and renderer-agnostic.

## Cockpit dual-track navigation

Spark Cockpit splits **Workbench** (daily assignment/ops) from **Console**
(setup/admin). Existing routes remain; shells differ.

### Workbench sidebar

| Area | Entries | Route |
| --- | --- | --- |
| Session rail | Sessions list + new session | `/sessions`, `/sessions/<id>` |
| Secondary nav | Overview | `/<workspace>` |
| Secondary nav | Inbox | `/<workspace>/inbox` |
| Secondary nav | Artifacts | `/<workspace>/artifacts` |
| Settings buttons | Global settings | `/settings` |
| Settings buttons | Workspace settings | `/<workspace>/settings` |
| Account control | Switch / create workspace | popover only |

### Console navigation

| Group | Entries | Route |
| --- | --- | --- |
| Global | Global settings | `/settings` |
| Global | Channels | `/settings/channels` |
| Workspace | Workspace settings | `/<workspace>/settings` |
| Workspace | Registration | `/<workspace>/settings/registration` |
| Setup | Create workspace | `/workspaces/new` |

Workbench settings buttons and Console nav are the entry points into Console.
The Workbench account control only switches or creates workspaces. Workspace
search, breadcrumbs, and nested detail routes stay on the Workbench shell;
Console uses its own top bar with **Back to workbench**.

## Implementation sequence

1. Land this concept contract and annotate older docs that still present `pi-*`
   packages as the final canonical direction.
2. Keep `packages/spark-artifacts/src/generative-ui.ts` as the `spark.ui.v1` types, parser, catalog
   validation contracts, and security tests home.
3. Render streaming `spark.ui.v1` output in Cockpit chat with raw fallback.
4. Persist source and derived UI AST artifacts and replay them in artifact detail
   views.
5. Keep Cockpit dual-track Workbench/Console shells aligned with the taxonomy above.
6. Rename core capability packages (`extension-api`, `artifacts`, `tasks`,
   `workflows`, `loop`, `modes`).
7. Rename remaining non-`btw` adapter capabilities (`ask`, `context`, `cue`,
   `files`, `graft`, `learnings`, `recall`, `roles`).

## Validation expectations

Each implementation wave should provide bounded evidence:

- Focused tests for any parser/security/renderer behavior changed in that wave.
- Typecheck or package checks for affected packages.
- Grep evidence for package rename waves, explicitly showing `pi-btw` as the
  remaining intentional `pi-*` package.
- Cockpit manual or automated smoke evidence for live rendering, artifact replay,
  and grouped navigation when those surfaces change.
