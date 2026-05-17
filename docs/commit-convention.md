# Commit convention

Use git emoji commits, matching the cue-shell style.

Examples:

```text
🔧 chore(workspace): scaffold spark monorepo
✨ feat(core): add runtime validation and errors
✨ feat(tasks): persist thread task graph
🐛 fix(tasks): reject cyclic dependencies
♻️ refactor(agents): split json runner parser
✅ test(artifacts): cover artifact lineage queries
📝 docs(spark): document package architecture
```

Common prefixes:

- `✨ feat(scope): ...` — new capability
- `🐛 fix(scope): ...` — bug fix
- `♻️ refactor(scope): ...` — internal restructuring
- `✅ test(scope): ...` — test-only change
- `📝 docs(scope): ...` — documentation
- `🔧 chore(scope): ...` — tooling, scaffold, config
