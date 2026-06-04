# spark-workflows vendoring notes

## Upstream

- Source: https://github.com/QuintinShaw/pi-dynamic-workflows
- Revision: 0040b2292c398cf5aa4134047dd00ed798625d19 (latest main fetched for M1)
- Upstream package version at revision: 1.9.3
- Upstream license: MIT
- Upstream author: QuintinShaw
- Upstream contributor/original author noted by upstream: michaelliv

## License notice

The vendored source is derived from MIT-licensed @quintinshaw/pi-dynamic-workflows. Preserve upstream attribution when redistributing substantial portions of the code.

## Copied, rewritten, and renamed

This package rewrites the selected workflow core as Spark-owned primitives:

- metadata.ts: literal workflow metadata parsing and validation inspired by upstream parseWorkflowScript/meta handling.
- runtime.ts: sandboxed script execution with phase, agent, parallel, pipeline, journal hash, and resume-journal primitives.
- builtins.ts: Spark-owned deep_research and adversarial_review example factories based on upstream workflow shapes.
- types.ts: SparkWorkflow\* data contracts for future Spark role-run adapter wiring.

## Omitted upstream features

The following upstream surfaces were intentionally not copied for M1:

- Pi extension entrypoint, workflow tool registration, and automatic slash commands.
- Interactive /workflows TUI, editor, live task panel, and input-box rainbow mode.
- Raw Pi subagent spawning, model registry access, token/cost accounting, and worktree mutation code.
- Saved/nested workflow command registration and global storage layout.
- Web tool adapters and unneeded built-in generators beyond the two M1 workflow concepts.

## Local ownership

After this vendoring step, packages/spark-workflows is treated as Spark-owned code. Future API names, file layout, and behavior should follow Spark project semantics; Spark runtime role-runs will be wired in m1-workflow-role-adapter.
