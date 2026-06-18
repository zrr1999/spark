# Agent and Repo Definition Research

Date: 2026-05-25

This note records the profile-definition lessons from four nearby agent systems:

- [ShigureLab/nyako](https://github.com/ShigureLab/nyako)
- [ShigureLab/nyakore](https://github.com/ShigureLab/nyakore)
- [MayDay-wpf/snow-cli](https://github.com/MayDay-wpf/snow-cli)
- [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)

## Findings

### nyako / nyakore

The cleanest idea is the split between a definition repo and a runtime core.
`nyakore` owns runtime/session/artifact/terminal behavior, while `nyako` owns
agents, tools, skills, prompts, schedules, and policy. That maps well to Navia's
profile/workspace split: a profile is versioned input; a workspace is the
server-side instance created from that input.

Agent definitions are directory based:

```text
agents/<agent-id>/
├── agent.toml
├── AGENTS.md
├── IDENTITY.md
├── SOUL.md
├── TOOLS.md
├── USER.md
└── MEMORY.md
```

The TOML file carries structured execution metadata: `id`, `name`, `role`,
`tools`, `[skills]`, and `[model]`. Markdown files carry prompt/persona/tool
guidance. This keeps machine-readable policy separate from long-form prompt
text and makes agent diffs easy to review.

Secrets and runtime state stay outside the definition repo. Credentials are
referenced by id, not committed as values.

### snow-cli

snow-cli models sub-agents as scoped workers with a role, description, optional
configuration profile, and explicit tool permissions. The key lessons for Navia:

- Sub-agents should be selected by task fit, not treated as all-purpose clones.
- Tool grants should be explicit and minimal.
- Model/profile selection can be per agent.
- Sub-agent context is isolated from the parent workflow.

This supports keeping agent profile fields like `role`, `tools`, `model`, and
`skills` first-class in Navia TOML, rather than burying everything in an opaque
prompt blob.

### oh-my-pi

oh-my-pi's task agents normalize into a compact shape: name, description,
system prompt, tools, allowed spawns, model, thinking level, output schema, and
blocking behavior. Agent discovery merges project/user/bundled sources with
deterministic precedence and skips invalid custom files without breaking the
whole runtime.

Its isolation model is also relevant to repo definitions: delegated work can run
in isolated worktrees/overlays, then return patches. For Navia, repo definitions
should therefore describe checkout and sync behavior, not just a Git URL.

## Navia Decisions

Navia should keep TOML as the structured profile format and require directory
agents. Flat `agents/*.toml` files are intentionally not supported.

Preferred profile layout:

```text
settings.toml
agents/
  reviewer/
    agent.toml
    AGENTS.md
    TOOLS.md
  coder/
    agent.toml
repos/
  paddle.toml
  docs.toml
```

Agent TOML should support:

- identity: `id`, `name`, `description`, `role`
- execution surface: `tools`, `spawns`, `blocking`
- model policy: `[model]`
- skill policy: `[skills] enable/disable`
- prompt file list: `[prompts] files = [...]`
- open-ended extension: `[config]`

Repo TOML should support:

- identity: `id`, `name`, `provider`, `uri`
- version target: `defaultBranch`
- usage: `roles`
- trust/safety: `trust`, `[permissions]`
- local execution shape: `[checkout]`
- remote sync shape: `[sync]`
- open-ended extension: `[config]`

Profile parsing should be strict: `id`, `name`, lifecycle fields, and declared
prompt file lists must be explicit instead of inferred from filenames or
directory contents. Server-side Navia can store these richer fields in existing
`config_json` columns for v0.1. A later migration can promote high-query fields
once product usage proves which fields need indexing.
