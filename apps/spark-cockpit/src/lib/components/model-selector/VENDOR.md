# Svelte AI Elements model selector provenance

- Upstream: <https://github.com/SikandarJODD/ai-elements>
- Upstream commit: `fa4bc217f84bc571378bc371332a154106772614`
- Original registry: <https://svelte-ai-elements.vercel.app/r/model-selector.json>
- Original files: `src/lib/components/ai-elements/model-selector/*`
- License: MIT; retained in `UPSTREAM-LICENSE.txt`
- Imported: 2026-07-13
- Last reviewed upstream commit: `fa4bc217f84bc571378bc371332a154106772614`

## Local changes

`ModelPicker.svelte` is a Spark-owned, source-derived composition rather than a registry snapshot.

- Kept the upstream searchable Dialog + Command interaction, implemented on the supported Bits UI
  primitives and Spark design tokens.
- Replaced upstream model/provider shapes with the small `ModelPickerGroup` presentation contract.
- Removed AI SDK, Tailwind, shadcn-svelte runtime, and `models.dev` logo requests.
- Uses local monograms so Cockpit remains useful without external UI assets.
- Leaves provider authentication, catalog truth, session model changes, and SvelteKit form submission
  in the owning Cockpit route and Spark daemon.

Review upstream manually and port useful behavior deliberately. Do not run the registry installer over
this directory.
