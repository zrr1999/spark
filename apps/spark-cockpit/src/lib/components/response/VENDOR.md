# Svelte AI Elements Response source provenance

- Upstream: <https://github.com/SikandarJODD/ai-elements>
- Upstream commit: `fa4bc217f84bc571378bc371332a154106772614`
- Reviewed source: `src/lib/components/ai-elements/response/response.svelte`
- Registry item: <https://svelte-ai-elements.vercel.app/r/response.json>
- License: MIT; the required upstream notice is retained in `UPSTREAM-LICENSE.txt`
- Imported: 2026-07-17

## Local changes

- Kept the upstream `Streamdown` composition, but selected the maintained `svelte-streamdown`
  package and its opt-in code, math, and Mermaid components.
- Replaced Tailwind and `mode-watcher` with Cockpit token CSS and the renderer's automatic
  light/dark Shiki themes.
- Kept renderer props open so Cockpit can select streaming/static parsing, animation, controls,
  and security policy without owning a second Markdown parser.
- Added a Cockpit-owned streaming caret and a fixed validation origin so relative local media
  remains valid without broadening the renderer's URL protocol policy.
