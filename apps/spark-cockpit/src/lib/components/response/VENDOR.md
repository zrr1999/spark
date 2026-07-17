# Svelte AI Elements Response source provenance

- Upstream: <https://github.com/SikandarJODD/ai-elements>
- Upstream commit: `fa4bc217f84bc571378bc371332a154106772614`
- Reviewed source: `src/lib/components/ai-elements/response/response.svelte`
- Registry item: <https://svelte-ai-elements.vercel.app/r/response.json>
- License: MIT; the required upstream notice is retained in `UPSTREAM-LICENSE.txt`
- Imported: 2026-07-17

## Local changes

- Kept the upstream `Streamdown` composition and light/dark GitHub Shiki themes.
- Replaced Tailwind and `mode-watcher` with Cockpit token CSS and Streamdown's light/dark theme tuple.
- Enabled the bundled CJK, math, and Mermaid plugins for rich AI-authored Markdown.
- Kept Streamdown props open so the Cockpit boundary can select streaming/static parsing, caret,
  animation, controls, and security policy without owning a second Markdown parser.
