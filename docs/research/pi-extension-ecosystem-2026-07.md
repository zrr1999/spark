# Pi extension ecosystem research for Spark self-owned capabilities (2026-07)

## Scope

This report supports Spark's self-owned extension plan after the package-boundary cleanup. It focuses on memory, web access, compact/output reduction, and prompt-cache optimization because those are the gaps most visible in the native Spark host family.

Evidence used:

- Local READMEs: `~/.pi/agent/npm/node_modules/pi-memory/README.md`, `~/.pi/agent/npm/node_modules/pi-web-access/README.md`.
- Public package/repo search for `pi-hermes-memory`, `pi-cache-optimizer`, `@hypabolic/pi-hypa`, `lowfat`, and `pi-rtk`.
- Current Spark code inspection: `packages/spark-learnings`, `packages/spark-recall`, `packages/spark-turn/src/tool-result-compaction.ts`, `packages/spark-roles/src/index.ts`, and workflow-run registration code.

## Current Spark baseline

- Memory-like state is split across:
  - `spark-learnings` for evidence-backed `.learnings/` records and now the deterministic reflection pipeline.
  - `spark-recall` for explicit scoped recall candidates.
  - `/reflect` candidate/report files under `.spark/reflections/`.
- There is no `packages/spark-memory` package yet.
- Tool-result compaction exists in `spark-turn` and already supports exact/log/status/diagnostic profiles plus raw-result recovery artifacts.
- Native web tools are not implemented as a Spark package. `spark-roles` allowlists `web_search`, `code_search`, `fetch_content`, and `get_search_content`, and workflow code refers to web/fetch helpers, but the native host still needs a real self-owned provider-backed implementation.
- Prefix-cache optimization is not a first-class subsystem. Prompt assembly remains primarily host/bootstrap driven; cache behavior is inferred from provider usage where available.

## Reference findings

### `pi-memory`

Useful design points:

- Plain Markdown storage under `~/.pi/agent/memory/` (`MEMORY.md`, `SCRATCHPAD.md`, daily logs).
- Optional `qmd` integration for keyword, semantic, and hybrid search.
- KV-cache-stable memory snapshots: context injection refreshes only at deliberate checkpoints such as session start, before compact, long-term writes, or day rollover.
- Session handoff is written before compaction, so state survives context-window resets.

Spark implication: adopt stable snapshot injection and compact handoff semantics, but keep automatic memory writes explicit and evidence-backed. Avoid per-turn prompt-dependent memory injection by default because it destroys prefix stability.

### `pi-hermes-memory`

Useful design points from package/repo search:

- Categorized memories: failures, corrections, insights, preferences, conventions, tool quirks.
- Session search and consolidation rather than only long-term notes.
- Policy-only memory prompt by default, with legacy full injection as an escape hatch.
- Secret scanning blocks API keys/tokens from being saved.
- Correction/failure capture is treated as high-value memory.

Spark implication: `spark-memory` should use typed categories and secret scanning, and default to policy-only prompting plus explicit search. Full content injection should be opt-in and cache-aware.

### `pi-web-access`

Useful design points from the installed README:

- `web_search`, `code_search`, `fetch_content`, and `get_search_content` cover the exact tool names already expected by Spark role/workflow code.
- Search provider fallback: Exa, Perplexity, Gemini API, and Gemini Web when configured.
- Fetch fallback: Readability, RSC parser, Jina Reader, Gemini extraction, GitHub clone, PDF extraction, YouTube/video understanding, local video frame extraction.
- Full content is stored for later retrieval through `get_search_content`, while tool responses stay bounded.
- Curator UI is useful but can be a second phase; the core need is reliable native host tools.

Spark implication: implement `packages/spark-web` with the same public tool names and staged provider fallbacks. First phase should prioritize SSRF protection, prompt-injection sanitization, GitHub clone handling, Readability/Jina fallback, PDF text extraction, and stored full-content retrieval. Video/curator UI can follow.

### `pi-cache-optimizer`

Useful design points from package/repo search:

- Reorders stable system prompt content before dynamic context.
- Adds conservative OpenAI-compatible `prompt_cache_key` when the provider path supports it.
- Warns about proxy/cache-routing compatibility gaps.
- Displays read-only cache hit/write statistics in UI surfaces.

Spark implication: split prompt assembly into stable and dynamic segments, snapshot dynamic segments at explicit state checkpoints, and surface cache usage in status/footer views when providers return usage metadata.

### `@hypabolic/pi-hypa`, lowfat, and `pi-rtk`

Useful design points:

- Local deterministic reducers are preferred over LLM summarization for noisy command output.
- Profiles/levels such as lite/full/ultra let users trade fidelity for token savings.
- Recoverable evidence is critical: compact output should keep errors, paths, exit codes, and a way to retrieve the full original.

Spark implication: continue extending deterministic `spark-turn` tool-result compaction rather than adding summarizing LLM calls. Keep exact-read tools exact, use profiles for noisy logs/status, and record raw trace artifacts when compaction omits significant output.

## Recommended Spark-owned capabilities

### 1. `packages/spark-memory`

Goal: one policy and search surface over learnings, recall candidates, and reflection outputs.

Recommended public tool: `memory({ action })` with actions such as `remember`, `recall`, `search`, `status`, and `forget` only after conflict analysis with existing Pi `memory_*` tools.

Implementation constraints:

- Keep `learning` and `recall` public names stable; they can become adapters or sub-domains, not disappear.
- Store global memory under Spark XDG paths and project memory under `.spark/memory/`.
- Use categories inspired by Hermes: failure, correction, insight, preference, convention, tool-quirk.
- Add secret scanning before writes.
- Default to policy-only + stable snapshot injection; explicit search retrieves bodies.
- Flush compact handoff entries before session compaction.

### 2. `packages/spark-web`

Goal: native web/search/fetch tools for both Pi-compatible and Spark-native hosts.

Recommended public tools must match existing expectations:

- `web_search`
- `code_search`
- `fetch_content`
- `get_search_content`

Implementation constraints:

- Provider fallback should be deterministic and observable.
- Stored full content must be retrievable by response id.
- Fetch must protect against SSRF/local network access unless explicitly allowed.
- Retrieved page/video text must be treated as untrusted evidence, not instructions.
- GitHub repo fetch should clone or materialize a local tree when feasible rather than scrape rendered HTML.

### 3. Compact enhancement

Goal: complete the deterministic compaction path already started in `spark-turn`.

Recommended next work:

- Expand profiles for common command/status outputs.
- Keep exact reads and fetched content exact.
- Persist recoverable raw trace artifacts for significant omitted output.
- Integrate compact handoff with future `spark-memory`.

### 4. Prefix-cache optimization

Goal: make prompt/cache behavior observable and stable across turns.

Recommended next work:

- Split stable prompt sections from dynamic context in native host bootstrap.
- Refresh dynamic snapshots only at explicit checkpoints: mode/drive changes, compaction, goal/task state changes, memory long-term writes, day rollover.
- Add OpenAI-compatible `prompt_cache_key` where safe.
- Surface cache read/write token usage when provider usage metadata includes it.

## Execution order

1. Land this docs/research slice and current docs structure.
2. Implement `spark-memory` because compact handoff and prefix-cache policy depend on it.
3. Implement `spark-web` to satisfy role/workflow net-tool expectations in native hosts.
4. Extend compact profiles and recovery using the already-landed `spark-turn` compaction foundation.
5. Add prefix-cache segmentation and usage observability.
6. Finish with dual-host registration/integration tests across Pi extension loading and Spark native `BUILTIN_EXTENSION_FACTORIES`.

## Non-goals

- Do not auto-promote recall/reflection candidates into durable memory without explicit action or review.
- Do not make web content executable prompt material.
- Do not let a memory package read/write task graph or artifact stores outside owner APIs.
- Do not replace existing canonical public tool names in this project.
